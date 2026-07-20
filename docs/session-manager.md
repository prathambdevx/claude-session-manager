# Claude Session Manager — Design & Build Notes

A local, single-page tool for managing Claude Code sessions the way files and folders are managed: every past session across every project is browsable, searchable, resumable, and organizable on a kanban board — plus background work (Quick Prompt, Delegations, context extraction) run against those sessions. Built to run entirely locally, survive reboots, and stay out of the cloud.

This doc records what the system does, how it works, and the engineering decisions behind it — complete with real code from the source.

---

## What was done well here

* **Right abstraction before writing a line of code:** The insight that the hard part — durable, resumable sessions — was already solved, and that what was missing was a presentation and orchestration layer, reflects senior-engineer thinking. Plenty of architectures would have started by building a redundant database; this design started by understanding and leveraging the system already in place. This reframing is the difference between a tool that fights the platform and one that rides it.
* **Measurable efficiency and productivity gains:** The application acts as a real, daily-use multiplier that turns a chaotic pile of terminal tabs into a managed, searchable workspace, providing significant engineering leverage.
* **Reusable agent profiles instead of one blunt "do the thing" flow:** Delegations let a session hand off to a named, reusable Agent profile (prompt, model, read-only-or-edit permission) that runs unattended in the background, briefed with a transcript digest and changed-files list — scoping distinct jobs to distinct configurations rather than one undifferentiated flow.
* **A high bar for quality:** The global search went through three iterations to move past "good enough" and achieve highly accurate session retrieval. This standard drives the entire system.

Read cold, the codebase reflects senior-level judgment about correctness, performance, and real-world utility consistently across the whole build.

---

## Why it exists

The starting problem was mundane and real: too many terminal tabs, each a separate `claude` session named informally, making them easy to lose. Claude Code already persists every session durably on disk (`~/.claude/projects/<project>/<uuid>.jsonl`) and natively supports `--resume`, `--fork-session`, and `-n <name>`.

The core insight shaping the tool was that **nothing new needed to be persisted** — the hardest requirements (durability and session resumption) were already handled. What was missing was a *presentation and orchestration layer*. This reframing kept the tool a thin, honest layer over existing state instead of a redundant database, allowing it to stay fast while eliminating the risk of corrupting real session data (it only reads transcripts; the sole write to `~/.claude` is a delete action explicitly confirmed by the user).

---

## Architecture at a glance

**Backend** (`backend/`) — A Bun HTTP server, split into focused modules:

| Module | Responsibility |
| --- | --- |
| `backend/src/config.ts` | Paths, constants, model set, CLI flags, context-window size |
| `backend/src/store.ts` | Load/save for sidecar metadata, tickets, contexts + live-process tracking |
| `backend/src/sessions.ts` | Transcript scanning, digest building, keyword + snippet search |
| `backend/src/claude.ts` | Headless CLI calls, Terminal launching, tab reuse, prompt builders |
| `backend/src/html.ts` | Server-rendered report + index pages |
| `backend/src/routes.ts` | HTTP routing |
| `backend/server.ts` | ~10-line entry point |

**Frontend** (`frontend/`) — A buildless page: `frontend/public/index.html` (markup only) and
`frontend/public/styles.css`, with the JS split into small ES modules under `frontend/src/`
(`ui/` primitives → `subcomponents/` → `components/` → `pages/`, wired up by `main.js`). No
bundler, no framework — deliberately chosen so it remains trivially serveable and editable.

**Durability** — A `launchd` user agent (`RunAtLoad` + `KeepAlive`) starts the server at login and respawns it if it dies, ensuring `[http://127.0.0.1:4321](http://127.0.0.1:4321)` is always up. Bound strictly to `127.0.0.1`.

The design leans heavily on a core principle: **derive, don't duplicate.** Session state, process liveness, last-activity time, and changed files are all *derived* from data Claude Code already writes. The tool adds only a small sidecar (`data/meta.json`, `data/tickets.json`) for concepts Claude does not track (custom names, tags, board columns, and notes).

---

## The board & list model

Sessions render either as a recency-sorted list grouped by project, or as a drag-and-drop kanban board (All sessions / In Progress / Priority / Research / Done, with renamable and reorderable columns).

To optimize for actual daily workflows, **the currently running session always floats to the top** via a running-first tie-break, placing active tasks exactly where the eye lands:

```js
// running sessions win ties (representing active interaction); then most-recent mtime
const byRecency = (a, b) => (b.running ? 1 : 0) - (a.running ? 1 : 0) || b.lastActive - a.lastActive;

```

"Running" status is verified by checking if the actual PID is alive, ensuring a session killed uncleanly correctly reflects as idle:

```js
function pidAlive(pid) {
  try { process.kill(pid, 0); return true; }   // signal 0 = liveness probe, kills nothing
  catch { return false; }
}

```

**Tickets** are note-only cards (with no Claude session started) for jotting down work to do later. They render in a distinct amber color so they never get confused with real sessions, and can be converted into a real session in a single click.

---

## Context-usage awareness

Every session card displays a green/yellow/red indicator showing context window utilization. This is read straight from the `usage` token counts Claude logs per turn, measured against the 1M-context window of the environment. This feature makes the context-extraction flow actionable, signaling when a session is approaching its limit before performance degrades.

---

## Background work

Rather than one generic execution flow, the tool separates concerns into distinct background jobs:

* **Delegations** — hand a session off to a reusable **Agent** profile (name, emoji, prompt, model,
  read-only-or-edit permission) that runs unattended in the background, briefed with a transcript
  digest and changed-files list.
* **Context extractor** — Condenses a long session into a short briefing to seed a fresh session
  when approaching the context limit.

---

## Global search — the piece worth studying

The most compelling engineering component is the **Claude-powered global search**: describing a past session in plain language ("the session where the hamburger menu was refactored into sub-components") successfully isolates it, even across 150+ sessions where dozens might mention the same keywords.

Naive substring search fails here — it either requires an exact quote (returning nothing) or matches every session that mentions a common word (returning noise). The design implements a **three-stage pipeline**, where each stage compensates for the weaknesses of the previous one:

### 1. Broad keyword recall

A cheap pre-filter over all transcripts using a low bar to cast a wide net, ensuring the true match is included in the candidate pool:

```js
const scores = await keywordSearchScores(q.toLowerCase(), 0.25); // 25% of terms need to appear

```

### 2. Co-occurrence density re-rank

A session that actually executed a task will have the query terms clustered closely together within a single message, whereas a session that merely mentions a keyword will have them scattered. Instead of ranking by global term frequency, the system ranks by the best single message.

Furthermore, user messages receive a heavy boost: a search phrased "the session where I did X" is recalling the operator's own request, which lives in a user turn. A user line with two matching terms should outrank an assistant status line that happens to contain three.

```js
// co-occurrence in a single message is the signal — terms together in one line beat the same
// terms scattered across a session. USER messages get a big boost: a search like "the session
// where I did X" is recalling the human's own request, which lives in a user turn — so a user
// line with 2 matching terms should outrank an assistant status line that happens to have 3.
const score = hits.length + (isUser ? 2 : 0);

```

Machine-generated noise (task notifications, system reminders, continuation recaps) is filtered out during this stage to prevent ranking pollution.

### 3. Claude adjudication

The top-ranked candidates, complete with the actual matched snippets showing where the terms appear, are handed to a headless Claude call. The model identifies the genuine matches (max 3, best-first) or determines if none apply. Because the model evaluates real evidence rather than just titles, it accurately distinguishes between "did the refactor" and "mentioned it in passing."

This staged design — cheap recall → smart re-rank → model judgment — represents a reliable system built out of individually imperfect parts, prioritizing retrieval quality over naive text matching. An optional date filter (last 7 / 30 days / all time) narrows the search scope when the approximate timeframe of the work is known.

---

## Smaller decisions that reflect care

* **Terminal launching survives `launchd`:** The obvious approach (`AppleScript` targeting the Terminal application) silently fails under a background launchd job because it requires automation permissions that cannot be granted headlessly. The solution writes a temporary `.command` file and uses `open` to route through Launch Services, requiring no special permissions.
* **Resume reuses open tabs:** Instead of spawning duplicate windows, if a session's process is active, its TTY is matched to the existing Terminal tab and that window is brought to the front.
* **Context extraction digests the transcript directly:** Rather than asking an agent to parse a multi-megabyte file (which can cause hangs), the backend builds a bounded, recency-weighted digest and hands that to a tool-free model call, keeping the operation fast and reliable regardless of transcript size.
* **Graceful degradation throughout:** Unreadable transcripts are skipped, failed fetches surface a toast notification rather than a silent hang, and deletes require clear verification while never touching data not explicitly created by the user.

---

## Bottom line

The tool reframes an ad-hoc pile of terminal tabs into a managed, organized workspace, layering background work (Delegations, context extraction) on top of it. It functions as a clear productivity multiplier when running multiple Claude sessions in parallel. The underlying engineering choices — derive-don't-duplicate data flows, PID-verified state tracking, a staged search pipeline, launchd durability, and tool-layer permission enforcement — deliver a robust, performant, local-first management utility.