# Live Updates: From Polling to Granular Push

How the board learns "this session is doing something" the moment it happens, instead of finding
out a few seconds later.

## The problem

Claude Code writes its own live state to disk while it works — a status file per running process
(`~/.claude/sessions/<pid>.json`) and an append-only transcript per session
(`~/.claude/projects/<project>/<sessionId>.jsonl`). This app doesn't control that process; it can
only watch what gets written and reflect it in the UI. The question was always: *how does the
browser find out something changed?*

## Where it started: polling

The simplest possible answer — ask on a timer. Every few seconds, the browser called
`GET /api/sessions`, the backend re-scanned every session's transcript and status file, and sent
the whole thing back. The frontend replaced its entire local list with whatever came back.

This is honest, simple, and was good enough for a long time. Its one real weakness is a structural
tradeoff, not a bug: there's always a gap between something actually happening and the next
scheduled check. Shrink the interval and the gap shrinks — down to 1 second felt close to instant
— but it's still a clock, not an event. And every tick re-fetches and re-computes *every* session,
even the 99% that didn't change, just to catch the 1% that did.

## Where it ended up: granular push

The better answer, once it was worth the extra plumbing: **the server tells the browser the
instant something changes, and tells it exactly what changed** — not "something happened, go check
everything," but "session `abc123` just did this."

Three pieces make this work:

1. **A filesystem watcher** (`backend/src/fsWatcher.ts`) sits on the exact folders Claude Code
   writes to, using the OS's native change-notification API (no polling here either — the
   operating system itself wakes this code up the instant a file changes). One transcript write
   often fires several raw file events in a row, so nearby events for the same session are
   collapsed into a single recompute, and different sessions never block each other.

2. **A push channel** (`backend/src/sse.ts` + `backend/src/routes/events.ts`), using a browser-native
   feature called **Server-Sent Events (SSE)** — a plain HTTP connection the browser opens once and
   the server keeps open, writing a small message down it whenever there's something to say. No new
   protocol, no extra library: it's built into every browser as the `EventSource` API.

3. **In-place patching on the frontend** (`frontend/src/api/sse.js`). Instead of replacing the whole
   session list, each push updates just the one session (or Quick Prompt job) it's about, and the
   board re-renders. A busy session doing lots of work never causes every *other* card to
   re-fetch and re-render along with it.

A slow (1s) polling fallback still runs underneath all of this — purely as a safety net for the
rare moment the push connection is reconnecting (e.g. right after a server restart). SSE is the
real path now; polling is just the backstop.

## The two files behind "what's this session doing"

- `~/.claude/sessions/<pid>.json` — one per **live process**, tells you *whether* it's running and
  its current status (busy / idle / waiting). Deleted the moment the process exits.
- `~/.claude/projects/.../<sessionId>.jsonl` — one per **session**, the permanent transcript. This
  is where the actual message text comes from — the status file never contains that.

A status-file change and a transcript change mean different things, so the watcher treats them
differently: a status flip is a small, cheap patch (nothing about *what was said* changed); a
transcript write means real new content arrived, so that session gets fully recomputed and pushed.

## Why bother, for a project with exactly one user

Nothing here was strictly *required*. A single local user checking their own board doesn't have a
scaling problem — the old polling approach was never going to fall over. This was built anyway,
on purpose, as a deliberate exercise in the real pattern used by production real-time products
(Slack, Linear, Figma, and similar tools all push granular updates rather than re-fetching
everything on a timer). Doing it here — correctly, end-to-end, filesystem event to a patched DOM
node — was worth it for the sake of actually building the pattern once, not just reading about it.

## What actually makes this production-grade, not just a demo

It would have been easy to build a version of this that "works on the happy path" and quietly
breaks under real conditions. A few decisions here specifically guard against that:

* **Debouncing is per-entity, not global.** A single naive implementation would collapse *every*
  file event system-wide into one timer — meaning one session's flurry of tool calls would delay or
  swallow a completely unrelated session's update. Instead, every session and every job gets its
  own independent debounce key, so a busy session and a quiet one are never coupled to each other's
  timing at all.

* **The two data sources are trusted for exactly what they're good for, and not blindly merged.**
  Claude Code's own `status` field (busy/idle/waiting) was already found to get stuck reporting a
  stale value indefinitely on a long-running interactive terminal — confirmed live, not assumed. Rather
  than patch over that with a special case, the design treats "actively working" as a cross-check
  between the status file *and* real transcript freshness, computed identically (via one shared
  function, `computeActivelyWorking`) wherever it's needed — the REST endpoint, the watcher, and the
  frontend's own merge logic — so there's exactly one definition of truth, not three that could drift
  apart.

* **The system handles its own race conditions, not just the good case.** A running-status file's
  name only tells you a pid — the session id it belongs to only exists *inside* the file. When that
  file is deleted (a terminal closes), a naive design would lose the mapping the instant the delete
  event fires, since there's nothing left to read. Instead, the mapping is remembered in memory the
  moment it's last seen, specifically so a deletion can still be resolved correctly rather than
  silently dropped.

* **A deleted transcript degrades gracefully instead of throwing.** If a session is removed while
  the watcher is mid-recompute, the re-scan fails by design — that failure is caught and turned into
  an explicit `session-removed` push, so the UI correctly drops the card instead of crashing the
  watcher or leaving a zombie entry behind.

* **The fast path has an honest fallback, not a single point of failure.** Push-based delivery can
  drop — a server restart, a network blip — so a slow poll still runs underneath it the whole time.
  If SSE is momentarily down, the UI just gets slightly less snappy for a few seconds; it never goes
  silently stale.

* **Bandwidth scales with what actually changed, not with how much data exists.** Pushing one
  session's ~few-KB record instead of re-fetching and re-rendering the entire multi-hundred-session
  bundle on every tick means the cost of a live update is constant, regardless of how many other
  sessions happen to exist — the whole point of a production real-time system, not just a "does it
  demo well" one.

None of this is exotic — it's the ordinary discipline of thinking through failure modes (races,
partial data, dropped connections, one component's load affecting another's) before calling
something done, applied to a small project instead of skipped because the stakes seemed low.
