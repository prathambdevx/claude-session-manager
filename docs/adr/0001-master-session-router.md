# ADR 0001 — Master Session Router

**Date:** 2026-09-02
**Status:** Accepted (implementation in progress on `feat/master-session`)

## Context

Hand a task to one place and have it decide which of the currently-open Claude Code sessions should
receive it — or that a new session is needed. Today the equivalent is done by hand: find the right
session on the board, then Quick Prompt into it.

The obvious blocker is that deciding requires knowing what every session is about, and transcripts
are enormous. Measured on this machine: **490 transcripts, 796 MB total, median 222 KB, p90 869 KB,
largest 199 MB.** No router can read those per request.

Claude Code supplies every mechanical piece already — `claude agents --json` to enumerate,
`--resume <id> -p` to forward, `SendMessage` for cross-session messaging — but supplies no routing
*decision*. That part is ours. Research and sources: `docs/master-session-router-research.md`.

## Decisions

### 1. Route on maintained per-session digests, not on transcripts or keyword search

`/api/search/smart` already implemented "natural language in, which session out" and is hidden in
the UI as unreliable. Its first stage is `keywordSearchScores`, so a session only becomes a
candidate if it shares **literal words** with the query — ask about "the total is wrong after a
promo code" and a session that only ever said "discount" and "subtotal" is filtered out before any
model sees it. No downstream re-ranking can recover a candidate dropped upstream.

Routing on a maintained semantic digest removes that gate entirely.

### 2. Full coverage via rolling chunk summaries — NOT head+tail sampling

The two existing summarizers are both endpoint-biased: `summarizeSession` samples the first 4 and
last 4 user messages; `buildTranscriptDigest` keeps the first entry then fills a 120K-char budget
from the *end* backwards, printing `[... N earlier messages omitted ...]`. Correct for a card label,
wrong for routing — the work a task belongs to is usually in the **middle**. A session that spent 35
turns on discount/total logic and ended on a CSS fix summarizes as "fixed a margin".

So: summarize fixed-size chunks as the transcript grows, once each, forever. Coverage is complete
and total cost is O(conversation size).

Affordable because tool *results* are discarded. Measured: the 199 MB session holds only **1.4 MB
(~350K tokens)** of conversation — 0.67%. That is also why a single full-coverage call is
impossible regardless of cost: 350K tokens exceeds Haiku 4.5's 200K window. **Chunking is a
requirement, not an optimization.**

### 3. Byte-offset watermark, not an entry index

An entry-index watermark forces a re-parse of the whole file to skip covered entries — a full parse
of the 199 MB transcript is ~0.93s, paid on every catch-up even when nothing changed. Transcripts
are append-only JSONL, so storing a **byte offset** and seeking makes catch-up proportional to new
content. Guard: if current size < `coveredBytes` the file was rewritten, and the digest is rebuilt.

### 4. `CHUNK_CHARS = 12_000`, sized by coverage rather than context limit

First implemented at 40K. Backfill showed a typical session accumulating **zero** complete chunks,
leaving the router with only that session's raw tail — reintroducing the exact middle-blindness
this design exists to remove, relocated to small and medium sessions. 12K chars (~3K tokens) is far
under Haiku's window; the binding constraint was coverage granularity, not capacity.

### 5. The trailing partial chunk is served RAW, never summarized

Cheaper (no model call), never stale, and it is the strongest routing signal there is — what a
session is doing *right now*. Capped at 1,200 chars because it is multiplied by every candidate and
therefore dominates prompt size.

### 6. Background trickle, no startup sweep

A startup backfill over recent sessions would fire hundreds of Haiku calls at once (the largest
session alone needs ~117 chunks at 12K). Instead: one job at a time via `fsWatcher`, 3 chunks per
pass, 1.5s gap. Routing works from the first request regardless — every candidate always carries
its raw tail and file list even with an empty digest; coverage only improves accuracy.

### 7. Sonnet decides; a local heuristic hints and backstops

Routing is a judgment call — which session *owns* the code path — not a similarity ranking. Term
overlap cannot separate the session owning checkout totals from the one owning promo-code parsing;
both say "discount". A model reading two digests can.

A trained/embedding router was considered and rejected for now: there are **no training labels**,
similarity is the wrong objective per above, and with 10-30 candidates there is no retrieval problem
to solve (scoring exists to cut thousands to tens). The local heuristic is kept for two jobs it is
actually right for — the instant pre-submit hint, and the degraded fallback when the model call
fails or times out.

### 8. File paths stay in the prompt, relativized and filtered

Challenged as bloat, and it was: ~16K chars (~4K tokens) across 15 candidates. But paths answer a
different question than prose — what a session **owns**, losslessly, collected free during parsing.
Fixes applied instead of removal: strip the `cwd` prefix (identical on every path, repeated per
candidate) and filter `~/.claude/**`, `node_modules`, dotfiles and lockfiles, which were 5 of 40
tracked files and actively mislead the file-weighted heuristic. Result: **65% smaller, ~3,963 →
~1,421 tokens**, signal intact.

A shared index/legend scheme was measured and rejected: file overlap across candidates is only
**3%**, so a legend costs more than inline paths (5,978 vs 5,312 chars).

### 9. `POST /api/route` decides; it never sends

Delivery stays a separate call to the existing Quick Prompt path. Keeps the endpoint safe to call
speculatively, easy to test, and incapable of firing a prompt into a session by accident. Nothing
auto-sends: low confidence preselects nothing.

### 10. Exclusion, not inclusion, is the persistent scope control

A required "which sessions may be routed to" picker would collapse the feature — having chosen the
candidates you may as well Quick Prompt directly. Scoping is automatic (running, or active within
24h). The one persistent control is a **non-routable project list**, because test/dummy sessions
here are launched dangerous-mode and a task misrouted into one is acted on with no permission
prompt. Optional post-hoc narrowing reuses existing saved views rather than a parallel picker.

### 11. A warm standby `claude` process, not an API key

Measured cost breakdown of the original 12.3s decision:

| Measurement | Result |
|---|---|
| Full routing decision, Sonnet, cold spawn | 12.3s |
| `runClaudeHeadless`, *trivial* prompt ("Reply with exactly: OK"), Sonnet | **7.4-7.8s** |
| Same, Haiku | **7.9-9.4s** |

So ~7.5s was fixed `claude` CLI startup — process spawn plus config/plugin/MCP init — before any
prompt was considered. Consequences: token reduction can only touch the smaller half (which is why
the file-index idea in #8 was rejected), and switching the decision to Haiku buys nothing because
the overhead is CLI-bound, not model-bound.

Rather than reach for an API key, `claude -p --input-format stream-json` is fed over stdin by a
pre-spawned process. Three measurements settled the design:

- **Reuse works** — 1st prompt 6.3s, 2nd 1.6s, 3rd 1.9s in one process.
- **Startup is EAGER** — spawned and left idle 10s, the first prompt answered in 2.5s not 6.3s. So
  warming genuinely front-loads the cost.
- **Context ACCUMULATES** — a second prompt could recall the first. So a process serves **exactly
  one** real prompt and is discarded; otherwise earlier routing decisions would bias later ones and
  input tokens would grow without bound. The replacement spawns immediately, while nobody waits.
- **Idle processes survive** — still ready and answering in 2.2s / 3.5s after 60s and 120s idle. No
  keep-alive pings are needed; the process simply blocks on a stdin read.

Readiness must be **proven, not timed**: the startup stream emits only hook events, with no
`init`/ready event to await. An earlier version treated "the standby object exists" as ready, handed
out still-booting processes, and produced cold timings (6.9s, 8.1s) from a supposedly warm pool. The
fix is a throwaway priming ping at spawn — when it returns, boot is provably done. Its ~20 tokens
are irrelevant since the process is discarded after one real use.

**Result: 9.7s -> 3.2s median (3.1x), and 3.34s end-to-end over HTTP.** No API key, no billing
change — same CLI the rest of the app already shells out to.

**Demand-warmed, not always-on.** An idle `claude` process measures ~157 MB RSS, too much to hold
permanently for a feature used a few times a day. So opening the Router page warms the pool and the
seconds spent typing a task cover the boot; 10 minutes of inactivity releases it. The cold path
(`runClaudeHeadless`) remains the fallback and is always correct — a missing or broken pool costs
speed, never correctness.

Deferred: an SDK-direct path would cut the remaining ~1-2s of transport, but needs an
`ANTHROPIC_API_KEY` and moves cost from the Claude Code plan to API billing. Not worth it now that
the CLI path is ~3s.

## Consequences

- One new background writer of model calls. Bounded by the trickle, but it is the first thing in
  this app that spends quota without a user action — the no-startup-sweep decision matters.
- Digests are a lossy cache of an append-only source. Always rebuildable; safe to delete.
- Very large sessions converge slowly (~117 chunks for the largest). Their raw tail and file list
  carry routing in the meantime.
- `buildTranscriptDigest`'s inline extraction moved to `sessions/entries.ts` so one implementation
  of "what counts as a conversational entry" serves both.
