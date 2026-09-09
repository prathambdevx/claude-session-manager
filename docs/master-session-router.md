# Master Router

Hand a task to one place; it decides which of your open sessions should take it, or that a new one
should. Then you click to send. **It never sends on its own.**

Design rationale and the measurements behind every choice: [`adr/0001-master-session-router.md`](./adr/0001-master-session-router.md).
Original feasibility research: [`master-session-router-research.md`](./master-session-router-research.md).

## Using it

Open the **Router** tab. Type what you need done. A ranked guess appears as you type (free, local,
no model call). Press **Route this task** for the real decision, then **Send** to deliver it.

Delivery reuses Quick Prompt, so the same rules apply: if the session's terminal is open the prompt
is typed straight in, otherwise it runs headless in the background.

Confidence drives the UI, not an auto-send:

| Confidence | Behavior |
|---|---|
| high / medium | Target preselected with its reasoning; alternatives listed below |
| low | **Nothing preselected** — the panel says so, you choose |
| degraded | The model call failed; you're seeing a file/project overlap guess, labelled as such |

## How it works

Three pieces, deliberately separated by *when* they run:

| Piece | Runs | Job | Model |
|---|---|---|---|
| **Digest layer** | Continuously, background | Summarizes each session's transcript in chunks as it grows | Haiku |
| **Router** | On submit | Reads digests, picks a target | Sonnet |
| **Delivery** | On your click | Sends via Quick Prompt | — |

The expensive work (parsing and summarizing hundreds of MB) happens *before* you ask, which is what
makes the decision one fast call. The router never reads a transcript.

### Digests

One file per session: `data/routing-digests/<sessionId>.json`.

```json
{
  "sessionId": "b4a1eeb1-…",
  "coveredBytes": 17505355,     // resume watermark — seek here, parse only what's new
  "coveredEntries": 979,        // provenance for chunk from/to
  "earlier": "…folded summary of older chunks…",
  "chunks": [{ "from": 751, "to": 979, "summary": "Fixed OTP 'already verified' classification…" }],
  "files": ["apps/bff/src/services/simply-otp/index.ts", "…"],
  "updatedAt": 1756…
}
```

Key properties:

- **Full coverage, not head+tail.** Every span is summarized once as the transcript grows. The
  existing `summarizeSession` (first 4 + last 4 messages) and `buildTranscriptDigest` (first entry +
  a tail budget) are both endpoint-biased — fine for a card label, wrong for routing, because the
  work a task belongs to is usually in the middle.
- **Affordable because tool results are discarded.** A 199 MB transcript holds only ~1.4 MB of
  actual conversation (0.67%).
- **The trailing partial chunk is read raw**, not summarized — free and never stale, and it's the
  strongest signal there is: what the session is doing right now.
- **Safe to delete.** Digests are a cache of an append-only source; they rebuild themselves.

Coverage grows over time. A session showing `warming` in the UI is being routed on recent activity
and its file list only — still useful, just less informed. Very large sessions converge slowly.

### Warm standby

The `claude` CLI costs ~7.5s of startup per invocation regardless of prompt, which was ~60% of the
original 12.3s decision. So a `claude -p --input-format stream-json` process is pre-spawned and fed
over stdin: **9.7s → 3.2s median.**

Because context accumulates across prompts in one process, each is used exactly once and replaced
immediately — otherwise old routing decisions would bias new ones. No keep-alive pings: an idle
process just blocks on a stdin read (verified alive and fast after 120s idle).

Warmed on demand (opening the Router page; your typing covers the boot), released after 10 minutes
idle, because an idle process holds ~157 MB. The cold path is always the fallback.

## Scope control

Candidates are any session **running**, or **active in the last 24h**. Liveness only ever *adds* a
candidate — `~/.claude/sessions/*.json` is known to lag, so it never filters one out.

The one persistent control is a **non-routable project list** (`data/routing-config.json`, or
`PUT /api/route/config`). Exclusion matters more than an inclusion picker: test sessions here are
launched dangerous-mode, so a task misrouted into one gets acted on with no permission prompt.

There is deliberately **no** "select which sessions to consider" gate — having chosen the
candidates, you may as well Quick Prompt directly, which collapses the feature.

## Endpoints

| Endpoint | Purpose |
|---|---|
| `POST /api/route` | The decision. Returns candidates, target, confidence, reason. **Never sends.** |
| `POST /api/route/hint` | Heuristic ranking only, no model call — for the live hint while typing |
| `POST /api/route/warm` | Boots the standby process (called when the page opens) |
| `GET/PUT /api/route/config` | Non-routable project list |

## Files

| Path | Role |
|---|---|
| `backend/src/sessions/entries.ts` | Streaming entry extraction, resumable byte offsets, noise filter |
| `backend/src/routing/digest.ts` | Digest model, chunk catch-up, `earlier` fold, shrink guard |
| `backend/src/routing/worker.ts` | Background trickle (3 chunks/pass, 1.5s gap) |
| `backend/src/routing/decide.ts` | Candidates, heuristic scorer, Sonnet decision |
| `backend/src/routing/config.ts` | Exclusions |
| `backend/src/claude/warmPool.ts` | Warm standby process |
| `backend/src/routes/router.ts` | Endpoints |
| `frontend/src/pages/routerPage.js` | The page |
| `frontend/src/api/routerApi.js` | Client |

## Gotchas

- **No startup backfill, by design.** A sweep would fire hundreds of Haiku calls at once (the
  largest session alone needs ~117 chunks). It trickles instead. This is the first thing in the app
  that spends quota without a user action, which is why it's throttled.
- **Small sessions may show zero chunks.** Below `CHUNK_CHARS` (12K chars of conversation) nothing
  is summarized yet; the raw tail carries them.
- **Digest generation uses `--no-session-persistence`**, so it never creates phantom sessions that
  would then appear as routing candidates.
