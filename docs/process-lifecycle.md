# Process lifecycle — what starts, tracks, and kills a session

Orientation for anyone (human or a future Claude session) about to touch launching, closing, or the
pollers. The app drives **real OS processes and real terminal windows**, so "is it alive" is never a
single boolean — treat these as four separate questions that can disagree:

1. **Is the `claude` process alive?** — pid liveness, from `~/.claude/sessions/*.json` via `loadRunning()`.
2. **Is a terminal window/tab open for it?** — Ghostty windows carrying the `csm-<id>` title tag.
3. **Is it actively working?** — transcript/status activity, separate from both of the above.
4. **Is there a headless job running for it?** — Quick Prompt / Delegation, which never had a window.

Nearly every subtle bug in this area comes from code assuming two of these are the same thing.

## The `csm-<id>` tag is the linchpin — and it's fragile

A launched session's window is identified **only** by a title tag `csm-<first-8-of-id>` (see
`ghosttyWindowTag`, `terminalLaunch.ts`). Ghostty's window/tab name is **not settable via AppleScript**,
so the tag is kept visible by a background loop baked into the launch script that re-asserts the title
via an OSC escape **every ~1 second** (`openTerminalRunning`, `terminalLaunch.ts`). Consequences:

- The tag can **briefly disappear** whenever Ghostty rebuilds a surface — most notably **dragging one
  window into another to form tabs**, which tears down and recreates surfaces. It returns within ~1s.
- Anything that reads "is a window open?" by scanning tab names is reading a signal that flickers.
  Never treat a single "tag not found" as authoritative.
- Each launch also writes a per-session **title file** (`GHOSTTY_TITLES_DIR/<id>.txt`). The OSC loop
  reads it every second, so a rename in the UI just rewrites this file. Its **existence also marks a
  session as "ours"** — see the orphan watcher below.

## Who kills a `claude` process — the complete list

Four places terminate a session's process — **all user-initiated.** There used to be a fifth,
automatic one (the orphan watcher); it's retired — see below for why.

| Killer | File | Trigger | Notes |
|---|---|---|---|
| Close terminal | `terminal/terminalFocus.ts` `closeRunningSessionTerminal` | user clicks "Close terminal" | Closes the window **and** `process.kill(pid)` — closing the window alone doesn't reliably kill claude. |
| Quick Prompt cancel | `routes/quickPrompts.ts` | user cancels a headless QP | `process.kill(j.pid)` (the `script`-wrapped pid). |
| Delegation cancel | `routes/delegations.ts` | user cancels a delegation | `process.kill(d.pid)`. |
| Headless/detached timeouts | `claude/headless.ts`, `claude/detachedRunner.ts` | internal timeout on a headless run | `child.kill()` on the spawned child only. |

Separately, `waitForPidExit()` (`store.ts`) escalates **any** of the above to `SIGKILL` if the pid
lingers past a 2s grace — a killed claude can survive several seconds after SIGTERM, and a `--resume`
racing against the still-dying process gets rejected as a concurrent session.

## The orphan watcher — retired (2026-07-25), do not re-enable as-is

**Purpose it was built for:** if you close a Ghostty window *directly* (not via the dashboard's
"Close terminal"), the underlying `claude` never gets killed — it survives as an orphan with no
window and the card's dot stays green forever. `polling/orphanWatcher.ts`'s `sweepOrphans()` swept
every 4s for exactly that: a pid-alive, non-headless session (identified by its title file) whose
`csm-<id>` tag is missing from the live Ghostty tab list.

**Why it's off:** confirmed live (see below) that Ghostty **never registers a drag-merged tab as a
scriptable `tab` element at all** — not a timing blip, a permanent gap. Any pid-alive-but-tag-missing
check is therefore unable to tell "window truly closed" from "window merged into another window as a
tab," and killing on the latter destroys a live session. There is no timeout long enough to fix this
— the tag is never coming back, ever, for a drag-merged session. Two rounds of tuning were tried and
both still failed the same way:
1. First fix: kill only after 3 consecutive missed sweeps (~12s), to survive the ~1s tag blip a
   merge causes while Ghostty rebuilds surfaces. Confirmed live this still killed a merged session —
   the miss isn't a blip in this case, it's permanent.
2. Second fix: switched to a 60s time-based grace. Also confirmed live to eventually kill a
   drag-merged session — just slower. Any threshold fails for the same reason.

**Root cause, confirmed via Ghostty's own `Ghostty.sdef`** (`/Applications/Ghostty.app/Contents/
Resources/Ghostty.sdef`) **and live AppleScript probing:** a tab created through Ghostty's own `new
tab` scripting command *is* correctly enumerable (id/index/selected/name, including when
unfocused/background) — the scripting API itself works fine. But a tab created by **dragging one
window into another** is invisible to `tabs of window`, to the accessibility (AX) tree, and to
`selected tab of window` alike. Ghostty's drag-merge code path simply never registers the result as a
`tab` object its own automation layer knows about. This is a gap in Ghostty 1.3.1 itself — no
polling, activation delay, or AX traversal from our side can see something Ghostty doesn't track.

**What this also breaks (still true, not just an orphan-watcher problem):** since resume/focus
(`tryFocusRunningSession` → `focusExistingGhosttyWindow`) uses the exact same `tabs of window` query,
a drag-merged session can never be re-focused either — see the next section for how the resume route
now handles that.

**If you ever revisit this:** the watcher's file (`polling/orphanWatcher.ts`) and its `startOrphanWatcher()`
call in `server.ts` are both still present, just not invoked (commented out) — the logic itself
(title-file gate, headless exemption, time-based grace) is sound for a window that's genuinely
*closed*; it's fundamentally blind to one that's *merged*. A real fix needs either an upstream
Ghostty fix for drag-merged tab registration, or abandoning window-tag detection for this case
entirely (e.g. never allowing drag-merge for sessions this app manages, by always creating multi-session
windows via `new tab` instead of relying on user drag).

## Resume refuses a duplicate when a drag-merged session can't be focused

`POST /api/sessions/:id/resume` (`routes/sessions.ts`) tries `tryFocusRunningSession` first. If that
fails but the session's pid is still alive, it does **not** fall through to spawning a new terminal —
a second `--resume <id>` would just get rejected by Claude Code as a concurrent-session conflict
anyway (see `waitForPidExit`'s comment). Instead it returns `{ ok: false, alreadyRunning: true, error }`,
and the frontend shows a toast telling the user to find the session's tab manually instead of silently
opening a broken duplicate window. As a manual workaround for exactly this case, the card's ⋮ menu has
"⧉ Copy resume command" (`copyCommand`, `sessionsApi.js`) — copies `claude --resume <id>` so the user
can paste it into whichever terminal actually holds that session.

## Restart / auto-update kills the *whole server*, not a session

`polling/autoUpdater.ts` polls `main` every 5 min; on a new sha it pulls and runs
`launchctl kickstart -k` which **SIGKILLs the entire launchd server process** (RunAtLoad/KeepAlive
bring it right back). This is why the usage-ping there must be `await`ed *before* kickstart — an
un-awaited `fetch` never flushes before the SIGKILL. It does **not** touch session terminals or their
`claude` processes; those are independent OS processes that keep running across a server restart.

## Liveness signals lag — don't trust one in isolation

- `loadRunning()` reads `~/.claude/sessions/*.json`, which Claude Code writes and **can lag** (stale
  "waiting"/"busy"). It's filtered to pid-alive entries, but "pid alive" ≠ "actively working".
- Window presence (tag scan) and pid liveness are **different questions** — a process can be alive with
  no window (orphan) or a window can outlive its process (Ghostty keeps the surface open on
  "process exited").
- "Actively working" has its own computation from transcript writes, not from the status file alone.

**Rule of thumb:** before adding logic that kills or hides a session, decide *which* of the four
questions above you actually mean, read the signal that answers exactly that, and debounce anything
derived from Ghostty window titles.
