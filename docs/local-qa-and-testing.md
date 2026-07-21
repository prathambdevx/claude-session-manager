# Local QA & testing (where things live, how to drive the app)

Orientation for anyone (human or agent) testing this app end-to-end on a real machine —
especially the terminal-launch / resume / quick-prompt flows that can't be unit-tested.
Read this before poking at Ghostty/Terminal-launch behavior locally.

## The running server

- **URL:** `http://127.0.0.1:4321`
- Runs as a **launchd** agent (`com.claude-session-manager`), *not* `bun run` in your shell.
  It does **not** hot-reload. After editing any `backend/**` file: **`bun run restart`**
  (= `launchctl kickstart -k gui/$(id -u)/com.claude-session-manager`), then poll the URL until it
  returns 200. Frontend files are served raw — just reload the browser.
- **Server logs:** `backend/launchd.log` (stdout+stderr of the live job). The repo-root
  `launchd.log` is **stale/empty — do not read it**. Confirm the real path any time with
  `launchctl print gui/$(id -u)/com.claude-session-manager | grep -i 'stdout path'`.
- To run the app with the orphan watcher/other pollers stopped for an isolation test, fully stop
  the job (it won't respawn until re-bootstrapped):
  `launchctl bootout gui/$(id -u)/com.claude-session-manager` … then restore with
  `launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.claude-session-manager.plist`.

## Where state lives on disk

- **Transcripts:** `~/.claude/projects/<project-slug>/<sessionId>.jsonl` — the slug is the cwd with
  `/` → `-`. Glob `~/.claude/projects/*/<sessionId>.jsonl` to find one regardless of project.
- **Liveness (per-process status):** `~/.claude/sessions/<pid>.json` — each holds a `sessionId`,
  `pid`, `status` (`busy` etc.). Written by Claude Code itself for *every* running session, however
  launched. `loadRunning()` reads these and filters to pid-alive. Can lag reality.
- **App's own state:** `data/` (a.k.a. `CSM_DATA_DIR`). Quick-prompt jobs are
  `data/quickprompts/<jobId>.json` (`status`: running|done|error, plus `result`/`error`/`progress`).
  Ghostty per-session title files: `data/ghostty-titles/<sessionId>.txt` — **presence of this file
  is how the app knows it launched a session** (used by the orphan-watcher ownership guard).

## Driving the app for a test (prefer the API over clicking the board)

The board at `/` is a **read-only "All Projects" overview with no launch button**, and with 100+
real sessions it's slow and fragile to drive by clicking. Prefer the HTTP API — it's exactly what
the UI calls. Use **Haiku + `dangerous:true`** for throwaway test sessions, and **delete them after**.

```bash
# 1. Launch a session (opens a real terminal window). Returns {sessionId}.
curl -s -X POST http://127.0.0.1:4321/api/launch -H 'Content-Type: application/json' \
  -d '{"cwd":"<abs-dir>","task":"Reply with exactly: hi","model":"haiku","name":"__test","dangerous":true}'

# 2. Close its terminal (SIGTERMs the process + waits for exit).
curl -s -X POST http://127.0.0.1:4321/api/sessions/<sessionId>/close-terminal -d '{}'

# 3. Quick prompt (open terminal → typed in; closed terminal → headless `claude --resume -p`).
curl -s -X POST http://127.0.0.1:4321/api/quickprompts -H 'Content-Type: application/json' \
  -d '{"sessionId":"<sessionId>","prompt":"hi"}'      # returns {jobId}; poll data/quickprompts/<jobId>.json

# 4. Clean up.
curl -s -X DELETE http://127.0.0.1:4321/api/sessions/<sessionId>
```

## Gotchas that will waste your time if you don't know them

- **Close only when the session is IDLE.** `close-terminal` SIGTERMs claude; if it's still working
  (mid-turn), claude writes `[Request interrupted by user]`, leaving the transcript ending on a
  dangling `user` turn. A later `claude --resume <id> -p …` then aborts immediately
  (`subtype:error_during_execution`, `result_type=user`, exit **143**). Wait for the transcript's
  writes to settle (mtime stable a few seconds) *and* an `"type":"assistant"` entry to exist before
  closing. A cleanly-idle close resumes fine.
- **A killed/interrupted transcript is permanently unresumable in `-p` mode** — retrying just
  appends more dangling turns and makes it worse. Use a fresh session when a test session gets into
  this state.
- **Playwright snapshots of the board are huge** (100+ cards → >100k tokens, exceeds the tool cap).
  Use `browser_find` with a regex, a depth-limited snapshot, or a screenshot to locate controls
  instead of a full `browser_snapshot`.
- **The orphan watcher only runs when Ghostty is installed** and kills sessions it launched whose
  window vanished. It skips: sessions with no title file (not ours), sessions with an open csm-tagged
  window, and sessions with a running headless quick-prompt/delegation job. Set
  `CSM_FORCE_TERMINAL=1` (launchd env) to force the Apple Terminal fallback path for testing without
  uninstalling Ghostty.
- `claude` is resolved to an absolute path at startup (`CLAUDE_BIN` in `constants.ts`) by probing the
  user's login shell — don't assume it's on the server's own PATH (launchd's is minimal).
