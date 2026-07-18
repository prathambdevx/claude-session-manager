# Claude Session Manager

Local, macOS-only dashboard for managing Claude Code sessions — a kanban board over the state
Claude Code already writes to `~/.claude/`. No database, no cloud.

## Run / verify

- `bun run start` — start the server (`http://127.0.0.1:4321`). `bun run setup` installs the
  auto-start `launchd` agent (usually already running).
- `bun test backend/tests` — the test suite.
- Typecheck/verify a change (there is **no build step to run the app** — see below):
  - `bun build backend/server.ts --outdir /tmp/check`
  - `bun build frontend/src/main.js --outdir /tmp/check-fe`

Always run the relevant build + `bun test backend/tests` before claiming a change works.

## Architecture

- **Runtime:** Bun (also the test runner and typechecker). Backend is TypeScript.
- **Frontend is vanilla ES modules served RAW** — `index.html` loads `/src/main.js` as
  `<script type="module">`, served straight from `frontend/src/` (see `routes/static.ts`). There
  is no bundler in the serving path; editing a module is live on the next browser reload. `bun build`
  on the frontend is **only** a typecheck — do not add a build/bundler or look for one.
- **No database.** Reads `~/.claude/projects/**/*.jsonl` (transcripts) and `~/.claude/sessions/*.json`
  (live per-process status) directly. The app's own state (board, meta, tickets, delegations,
  quick-prompts, etc.) lives as JSON files + per-item dirs under `data/` (`CSM_DATA_DIR`).
- **Server:** `Bun.serve` on 4321; router in `backend/src/routes/index.ts`, one file per resource.
- **Backend split by concern:** `claude/*` shells out to the `claude` CLI + drives Ghostty/Terminal;
  `store.ts` persistence; `sessions.ts` transcript scanning; `sse.ts` + `fsWatcher.ts` live push.
- **Frontend split:** `frontend/src/{api,components,pages,routing,ui,subcomponents}`.

## Key behaviors to know (non-obvious)

- **Real-time = SSE + backstop poll.** `fsWatcher.ts`/`sse.ts` push granular events; a 15s
  `loadSessions({background:true})` poll is only a reconnect-gap safety net, not the main path.
- **`render()` replaces `#app.innerHTML` wholesale.** Any push-driven refresh must skip it while a
  transient UI is open — that's what `isTransientUiOpen()` (menu/rename open) guards, used by both
  the SSE handler and the background poll. Don't rebuild the board out from under an open menu.
- **Ghostty launching uses native AppleScript `new window`, never `open -na`** (which spawns a new
  instance each time and broke focus/dedupe). Existing terminals are found by the `csm-<id>` title
  tag, not by pid. Background see `docs/ghostty-instance-bug-explainer.md`.
- **Quick Prompt has two delivery paths** (`routes/quickPrompts.ts`): if the session's terminal is
  open (tagged window exists) it types the prompt straight in via AppleScript keystrokes; if closed
  it runs headless `claude --resume <id> -p …` in the background (progress → card chip only, never a
  new window). Resume refuses to open a second terminal while a headless job is still running.
- **`loadRunning()` liveness comes from `~/.claude/sessions/*.json`** and can lag — treat "is a
  process alive" and "is a terminal window open" as different questions.
- **Per-session context %** uses a per-turn denominator: a turn whose real token usage exceeds 200K
  must be on the 1M window, so the scale flips per session (handles mid-session model switches).

## Working here

- **Commit/push only when explicitly asked** — never proactively. Branch first if on `main`.
- Match the surrounding code's style and comment density (comments explain *why*, not *what*).
- macOS-specific by design (real terminals, `launchd`) — don't try to make it cross-platform.
