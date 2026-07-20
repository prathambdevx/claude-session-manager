# Claude Session Manager — Current State Overview

A local, macOS-only kanban dashboard over the sessions Claude Code already writes to
`~/.claude/`. No database, no cloud — every session, its status, and its content are derived
from files Claude Code itself persists; the app's own data (`data/`) only stores what Claude
Code doesn't track: names, tags, board layouts, tickets, delegations.

This doc describes what's actually here today. It is not a changelog — if something below is
wrong, the code is the source of truth, not this file.

---

## Architecture at a glance

- **Runtime:** Bun — the server, the test runner, and the typechecker.
- **Backend** (`backend/src/`): `Bun.serve` on port 4321. Routed via `routes/index.ts`, one file
  per resource. Split by concern: `claude/` shells out to the `claude` CLI and drives terminal
  automation (`claude/terminal/` — see below); `store.ts` is all load/save persistence;
  `sessions/` scans and enriches transcripts; `sse.ts` + `fsWatcher.ts` push live updates.
- **Frontend** (`frontend/`): vanilla ES modules served **raw**, no bundler. `index.html` loads
  `/src/main.js` as a native `<script type="module">`; editing any module is live on the next
  reload. `bun build` on the frontend is a typecheck only.
- **Durability:** a `launchd` user agent keeps the server running across reboots/crashes,
  bound to `127.0.0.1` only.
- **Data model:** everything the app itself persists lives under `data/` as JSON files — no
  database. Deleting `data/` and restarting just re-seeds defaults; it never touches
  `~/.claude/projects` (the real transcripts).

---

## Views: Main board, Projects, per-project boards, saved views

The URL is the source of truth for which view is showing (`frontend/src/routing/boardRouting.js`),
so a refresh/back/forward always lands in the right place:

| URL | View |
|---|---|
| `/` | **Main board** — the live, primary board |
| `/projects` | **All Projects** — one column per project, auto-seeded, no "home" column |
| `/projects/<cwd>` | A **drilled-in project's own board** — its own independent column layout |
| `/views/<id>` | A **saved view** — a frozen column-layout snapshot, edits persist to itself only |

All four share the same rendering code (`renderBoardView.js`) through a small `ctx` object
(`cols` getter/setter + `save()`), so column features work identically everywhere.

### Column features (every board/view)

- Add, rename (inline), hide, delete, reorder (drag), collapse-to-pill (per-column or all-at-once).
- **Manage Columns panel** — a switch-list of every column: show/hide, rename, delete (or a 🔒 lock
  for the home column, the group lens, or a project's column while its filter is active),
  drag-to-reorder rows. Includes the **auto-hide-empty-columns** toggle, which sweeps any
  previously-populated-then-emptied column out of view (never a column that's simply new).
- **Project filter** (Main board only) — narrows just the home column down to one project's
  sessions, without touching any custom/project columns you've already organized. The filtered
  project's column auto-pins to the front. Rendered as a themed dropdown (not a native `<select>`).
- **"N hidden columns"** chip summarizes what's reopenable from Manage Columns.
- **Undo** — a per-board undo stack (30 entries) reverting the last structural change
  (add/rename/hide/delete/reorder/collapse/card-drop), independent per board/view.
- **"＋ Save as view"** — snapshots every column (hidden ones included, in place, so the true home
  column never loses its slot) into a new named saved view.
- Card placement in a plain custom column is **independent per board** — dragging a card into a
  column on Main board never makes it appear in a saved view that happens to share a column id.

### Sidebar & command palette

- **Sidebar** (`components/sidebar/`) lists Main board + every saved view (each with a rename/delete
  menu), plus every project (name + session count) — click to switch/drill in, drop a card on a
  project row to confirm/tag membership. A first-run "i" tooltip once explains what a view is.
- **⌘K / Ctrl+K command palette** — filterable jump list over every view and every project.

---

## The board card

Each session card (`frontend/src/subcomponents/boardCard.js`) shows: a live/idle dot, an editable
title, a project chip (color-coded consistently with that project's column), git branch, relative
last-active time, a description (or a "✦ auto-generate" button), and a **context-usage bar**
(green/yellow/red, `~N tokens (~X% of Yk)`).

Exactly one status chip shows at a time:
- **Job chip** — the session's most recent Quick Prompt job (spinner/step-text/progress while
  running, ✓/⚠ once settled, dismissible after).
- **Working chip** — the session is actively working right now, even if the prompt was typed
  straight into an open terminal rather than dispatched through Quick Prompt.
- **Done chip** — inferred from the transcript, auto-expires after 5 minutes, dismissible.

A **ticket** (a note-only card, no Claude session behind it) renders instead with a "TICKET" tag, a
Done/Reopen toggle, and "▶ Start session" — once started, it shows "▶ Resume" and mirrors its
started session's own chip.

Card actions: Resume, Fork, Edit description, Close terminal, Delete, and a ⚡ Quick Prompt
shortcut.

---

## Context-usage percentage

Computed per-session (`backend/src/sessions/index.ts`) by walking the transcript and accumulating
the last assistant turn's real token usage (input + cache-creation + cache-read), also reacting
immediately to a compaction event's own post-compaction token count. The denominator is decided
**per session**: if usage ever exceeds 200K, the window is assumed to be 1,000,000 (a plain 200K
model couldn't have produced that), otherwise the configured default — so the percentage scale
correctly flips if a session switches models mid-conversation.

---

## Terminal automation (macOS-specific)

All of it lives in `backend/src/claude/terminal/` — see `docs/terminal-auto-tiling.md` for the
tiling feature specifically, and `docs/ghostty-instance-bug-explainer.md` for why Ghostty is driven
via its own native AppleScript window-creation command instead of `open -na` (which used to spawn a
new OS process per launch and broke focus entirely).

- **Ghostty preferred, Apple Terminal as fallback** if Ghostty isn't installed.
- **Resume reuses an open window** — found by a `csm-<id8>` tag embedded in the window title, not
  by pid (pids can be stale/orphaned). Opens a new terminal only if none is found.
- **Window title stays live** — a background polling loop inside the window re-reads a small
  per-session title file every second, since Ghostty's window title is read-only via AppleScript;
  renaming a session in the UI just rewrites that file.
- **Auto-tiling** — every terminal this app opens reflows the app's own (tagged) windows into a
  layout as more open: 1st untouched, 2nd splits left/right, 3rd/4th fill the remaining quadrants,
  5th+ centers on top of the first 4. Tiles within whichever screen the oldest tracked window is
  currently on. Full detail: `docs/terminal-auto-tiling.md`.
- **Close terminal** — closes the window directly (bypassing Ghostty's own confirmation dialog) and
  separately kills the underlying process, since closing the window alone doesn't reliably do so.

---

## Real-time updates

Primary path is push, not polling: `backend/src/fsWatcher.ts` watches `~/.claude/sessions/*.json`
(live status) and `~/.claude/projects/**/*.jsonl` (transcripts) via native OS filesystem events,
debounced per-entity so unrelated sessions never block each other. Changes broadcast over
Server-Sent Events (`backend/src/sse.ts` + `routes/events.ts`) to `frontend/src/api/sse.js`, which
patches only the one affected session/job in place — never a full board rebuild while a menu or
inline rename is open. A slow 15s poll remains only as a backstop for the SSE reconnect gap, not
the main path.

---

## Background work: Quick Prompt, Delegations, Context extraction

- **Quick Prompt** (`routes/quickPrompts.ts`) — send an ad-hoc follow-up to an existing session
  without opening a terminal. Delivers by typing straight into an already-open terminal if one
  exists (confirms genuine completion by watching for both a new transcript entry and Claude
  Code's own idle status), otherwise runs headless in the background. The New Task/Quick Prompt
  modal's project field remembers your last pick.
- **Delegations** (`routes/delegations.ts`, `docs/agents-and-delegation.md`) — hand a session off to
  a reusable **Agent** profile (name, emoji, prompt, model, read-only-or-edit permission) to run
  unattended in the background, briefed with a transcript digest + changed-files list. The
  drag-a-card-onto-an-agent dock UI is currently **disabled** (`agentsDockHtml()` returns empty) —
  the backend/data model is fully live, just not surfaced in the board toolbar right now.
- **Context extraction** (`routes/contexts.ts`) — condenses a long session into a short briefing,
  which can seed a brand-new continuation session once the original is near its context limit.

---

## Search

- **Quick keyword search** (`GET /api/search`) — fast, threshold-based, powers the board's own
  search box.
- **Smart/global search** (`POST /api/search/smart`) — casts a wide keyword net, re-ranks by how
  densely the query terms co-occur in the actual transcript text (not scattered mentions), then
  asks Claude to pick the genuine best matches from the top candidates. **Currently hidden from the
  UI** — the trigger button is commented out in `index.html`; the route and modal are both fully
  functional, just not exposed right now.

---

## Tickets & Todos

- **Tickets** — lightweight, session-independent planning cards on the Sessions board (title, notes,
  project, per-board tag). Live alongside real session cards until converted into an actual session.
- **Todos** — a separate task board (own tab, own column set) for tracking work that isn't
  necessarily tied to a specific project/session yet; a todo can be "assigned to Claude," which
  either resumes an existing session with it as a continuation prompt or launches a brand-new one.

---

## Known currently-hidden features

These exist in the codebase and work, but aren't reachable from the UI right now (each was
deliberately disabled, not broken):
- **Agents dock** (drag-a-card-onto-an-agent delegation UI) — `agentsDockHtml()` returns empty.
- **Global search button** — commented out in `index.html`.
- **Extract-context modal** — not currently wired into the card menu.
