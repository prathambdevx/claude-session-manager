# Spec: tmux-backed terminals — dashboard as control plane

**Date:** 2026-07-21
**Status:** Finalized for review
**Scope:** macOS only (Windows explicitly out of scope for this work)

---

## 1. Goal

Today every terminal-facing feature (launch, resume, close, quick-prompt injection, auto-tiling,
orphan detection) is written against **Ghostty's AppleScript dictionary**, driven through
`osascript` / `System Events`. That forces every user to install and use Ghostty, and it is the
single largest source of fragility in the app (AX window-list polling, screen-frame math, position
clamping, silent TCC Automation/Accessibility denials).

Replace that with a **tmux-backed** architecture:

- The **dashboard is a pure control plane** — a web UI that shows session state and issues commands.
  There is **no terminal rendered in the browser**.
- Each Claude session runs inside a **tmux** session (detached-capable), which owns the process,
  survives the app restarting, and does pane **tiling** itself.
- When the user opens/resumes a session, the app launches **their own terminal** (Ghostty, iTerm2,
  Warp, kitty, Alacritty, WezTerm, or Apple Terminal) attached to tmux via `tmux attach`.

### Outcomes
- **No Ghostty requirement.** Users keep their own terminal, with their own theme/keybindings/UI.
- **Terminal-agnostic**, auto-detected; degrades to Apple Terminal (unremovable system app) as a
  guaranteed floor.
- **Deletes the fragile layer:** Ghostty `.sdef` automation, `System Events` window tiling, AX-list
  polling, the OSC title-refresh loop, and the Accessibility/Automation permission prompts.
- **More reliable per-feature** (§7): resume becomes reattach; quick-prompt becomes one path;
  close becomes deterministic; tiling becomes `tmux select-layout`; per-session focus becomes
  `tmux select-pane`.

## 2. Non-goals

- **Windows.** Untouched; tmux path is macOS-only.
- **In-browser terminal (xterm.js).** Rejected — users want their own terminal.
- **Independently-draggable OS windows across monitors.** tmux tiles panes *within one window*;
  spreading N separate movable windows across displays is not a goal (the fragile OS-window path we
  are removing). 1-4 side-by-side panes in one window is the supported tiling.
- **Rebuilding session/transcript scanning.** `sessions/*`, `~/.claude/projects/**`, context %,
  `reconcileClearedSessions`, quick-prompt job records, SSE/fsWatcher stay as-is except where noted.

---

## 3. Architecture

```
┌────────────────────────────────────────────────────────────┐
│ Dashboard (web) — CONTROL PLANE                             │
│  board, status (dot + chips), buttons: start · resume ·     │
│  quick-prompt · rename · close · fork. Issues tmux commands.│
│  No terminal in the browser.                                │
└───────────────┬────────────────────────────────────────────┘
                │ tmux commands (absolute tmux path)
                ▼
┌────────────────────────────────────────────────────────────┐
│ tmux (per-user server, shared socket /tmp/tmux-<uid>/)      │
│  runs the claude processes, holds panes, does the tiling,   │
│  survives app restart / browser close / terminal close      │
└───────────────┬────────────────────────────────────────────┘
                │ `open`/CLI launches the user's terminal
                ▼
┌────────────────────────────────────────────────────────────┐
│ User's terminal (Ghostty/iTerm/Warp/…/Terminal.app)         │
│  runs `tmux attach` — their own UI/theme; a dumb viewer     │
└────────────────────────────────────────────────────────────┘
```

The dashboard and any interactive terminal both talk to the **same** tmux server (same uid → same
default socket), so a session the app created is visible when the user attaches, and vice-versa.

---

## 4. Core model & naming

- **Claude session** — identified by its Claude session id (UUID), as today. One board card.
- **Grid** — a tmux session `csm-grid-<gridId>` (`gridId` = short hex; no `.`/`:`). Holds **1-4
  panes**. A single opened session is a grid of size 1. The grid is what a terminal window attaches
  to and the unit that gets tiled.
- **Pane** — one Claude process in a grid, carrying a tmux **pane user option**
  `@csm_sid=<claudeSessionId>` so the app (and a restart) can map panes ↔ sessions. Pane identity
  uses tmux's stable `#{pane_id}` (`%0`, `%1`, …), never positional indices (which renumber).

**tmux is the source of truth**, not app memory. The app caches a map in `data/tmux-state.json`
(`{ grids: {gridId:{panes:[{paneId,sid}]}}, activeGrid }`) but always reconciles against tmux on
startup and treats tmux as canonical (§10).

**Invariants:**
- A given Claude session id appears in **at most one** live pane at a time.
- Opening a session re-uses/focuses its existing pane rather than duplicating it.

---

## 5. Components

### New — `backend/src/claude/tmux/`
- `tmux.ts` — thin wrapper over the tmux CLI (absolute `TMUX_BIN`): `hasSession`, `newSession`,
  `splitWindow`, `killPane`, `killSession`, `sendKeys`, `selectLayout`, `selectPane`,
  `setPaneOption`, `listPanesAll` (→ `{session, paneId, sid, pid, attached}[]`), `listClients`,
  `renameSession`. Never throws on expected "no such session"; returns null/false.
- `terminalLauncher.ts` — resolves the target terminal app (§8) and opens/focuses it.
- `grids.ts` — grid/pane bookkeeping, reconciliation (§10), layout selection (§7.7), the
  session→pane resolver, and the dot/chip state derivation (§11).

### New — binary resolution
- `TMUX_BIN` resolved like `CLAUDE_BIN` (login-shell probe → known dirs → bare) — §9.

### Removed
- `claude/terminal/{terminalLaunch,terminalFocus,terminalInject,terminalTile,ghosttyEnv}.ts`.
- OSC title-refresh loop + `GHOSTTY_TITLES_DIR` / `writeGhosttyTitle` / `ghosttyWindowTag`.
- `polling/orphanWatcher.ts` (replaced by tmux reconciliation, §10).
- `routes/permissions.ts` and the Accessibility/Automation prompts in `setup.ts`.

### Changed
- `constants.ts` (+`TMUX_BIN`, −Ghostty); `setup.ts` (install tmux, capture `TERM_PROGRAM`, drop
  permission prompts); `routes/{launch,sessions,quickPrompts,contexts,todos}.ts` (call tmux layer);
  `store.ts` (`loadRunning` supplemented by tmux reconciliation).

---

## 6. The claude command, PATH, and the pane's shell (critical)

The server runs under **launchd with a minimal `PATH`** (`/usr/bin:/bin:/usr/sbin:/sbin`), which
tmux inherits — so a naive pane gets a broken PATH (the `CLAUDE_BIN` bug class already seen). So:

- `claude` is invoked by **absolute path** (`CLAUDE_BIN`, resolved via login shell).
- Each pane runs claude inside the user's **login+interactive shell**, so the session and its tools
  (git, node, …) get the real PATH:
  ```
  tmux new-session -d -s csm-grid-<g> -- \
    "$LOGIN_SHELL" -lic 'exec "<CLAUDE_BIN>" <flags> <task-or-resume-or-prompt>'
  ```
  (`-lic` sources `.zprofile` + `.zshrc`; `exec` so pane-close == claude-exit — a live pane always
  means claude is alive, never a lingering shell.)
- `TMUX_BIN` and `LOGIN_SHELL` (`$SHELL` or `/bin/zsh`) resolved once at startup.

---

## 7. Operation flows

All operations resolve a session to its live pane via `grids.ts`. "Not running" = no live pane.

### 7.1 Start (New Task) — `POST /api/launch`
1. `sid = crypto.randomUUID()`; build the claude launch command (`buildLaunchScript`, unchanged),
   wrapped per §6.
2. If a grid window is open and has < 4 panes → add as a pane to it (auto-tile, §7.3). Else create
   a new grid: `tmux new-session -d -s csm-grid-<g> -- <wrapped>`; `setPaneOption(pane,'@csm_sid',sid)`.
3. Open/attach the user's terminal to the grid (§8); `select-pane` to the new pane.
4. Persist meta/name as today.

### 7.2 Resume / Open a card — `POST /api/sessions/:id/open`
Resolve location, then:
- **Live pane + a terminal already attached** (dot green): do NOT duplicate.
  `tmux select-pane -t <paneId>` (cursor → that session's tile) + `open -a "<terminal>"` (bring the
  terminal app to front).
- **Live pane + no terminal attached** (dot grey, still running detached): open a terminal attached
  to its grid, then `select-pane`.
- **Not running**: create a grid with one pane running `claude --resume <sid>` (§6), stamp
  `@csm_sid`, open the terminal, `select-pane`.

**Focus precision (decided, now in scope):** `select-pane` *always* targets the correct session
(cursor lands there; typing goes to the right session) — reliable, terminal-agnostic. The
window-to-front step now does **exact-window raising**: `focusGridWindow` (see §8.2) matches the OS
window whose title contains the target grid's session name (`set-titles-string` embeds it, §7.6) via
`System Events`/AX (`AXRaise`), for the terminals with a reliable recipe (Apple Terminal, iTerm2,
Ghostty, WezTerm, kitty, Alacritty). This is strictly best-effort layered on top of app-activation,
never a replacement for it: no Accessibility permission, an unmatched title, or an unsupported
terminal (Warp) all fall straight back to plain `open -a` app-activation, silently — it never throws,
never blocks, and `select-pane` still lands in the right pane regardless of whether the raise
succeeded. It **never** types into the wrong session and **never** opens a duplicate.

### 7.3 Auto-tile / add to a grid
- Opening a **different** session while a grid window is open **adds it as a pane** to that grid
  (auto-tile): `tmux split-window -t csm-grid-<g> -- <wrapped>`; `setPaneOption @csm_sid`;
  `selectLayout` per §7.7; `select-pane` to it.
- If the active grid already has **4 panes**, the new session **spills into a new grid** (a new
  terminal window) — automatic, not an error. So: up to 4 tiled per window, then a new window.

### 7.5 Quick Prompt — `POST /api/quickprompts`
Single reliable discriminator — **does a live pane exist for this sid** (`tmux list-panes` + `@csm_sid`):

- **Running (attached OR detached):** `tmux send-keys -t <paneId> -l -- "<prompt>"` then
  `send-keys -t <paneId> Enter`. Works whether or not a terminal is attached — no focus theft, no
  keystroke simulation, no Accessibility permission. If attached, the user watches it live; if
  detached, it's in scrollback on next open. Card chip tracks progress.
- **Not running:** spin up an **attachable tmux session that starts on the prompt** (native path,
  decided):
  ```
  tmux new-session -d -s csm-grid-<g> -- "$LOGIN_SHELL" -lic \
    'exec "<CLAUDE_BIN>" --resume <sid> "<prompt>"'
  ```
  The prompt is claude's **initial argument** (same way New Task passes the task) — no send-keys
  boot race. The session is now a normal running (detached) session the user can open and watch
  live at any time — **no "wait until done."** All three scenarios thus reduce to "it's a tmux
  session; attach whenever."

**Removed:** the old open-vs-closed branching and the AppleScript-keystroke injection path. The
headless `--resume -p` path is no longer used for quick prompt (it remains for Delegations/search).
This also removes the interrupted-transcript failure mode, since closing a terminal no longer kills
the process.

Edge handling: collapse literal newlines + separate `Enter` (avoid early submit); `send-keys -l`
for literal text; target by stable `#{pane_id}`; don't start a second not-running session if one is
already being created for that sid. **Validate** that `claude --resume <id> "<prompt>"` accepts an
initial prompt in interactive mode (very likely — mirrors New Task with `--resume` added).

### 7.6 Rename — `PATCH /api/sessions/:id`
Dashboard metadata is the source of truth, as today. `setPaneOption @csm_name` keeps an open pane's
tag in sync. **Required (not optional): the rename must also show in the terminal's own title bar**,
replacing the deleted OSC title-file loop with tmux's native title propagation — `select-pane -T
<name>` sets the pane's title live, and the csm tmux config's `set-titles on` / `set-titles-string
"#{pane_title}"` (§8.2) pushes it straight to the terminal window's title, no reopen needed. In a
multi-pane grid the window title bar reflects whichever pane is currently active; per-pane labels in
that case come from `pane-border-format`/`pane-border-status`, toggled on only once a grid has more
than one pane.

### 7.7 Retile / layout ladder — applied on every pane add/remove
| Panes | tmux layout | Matches today |
|------:|-------------|---------------|
| 1 | (single pane) | `n===1` |
| 2 | `even-horizontal` (left/right) | `n===2` |
| 3 | `main-vertical` (big left + 2 stacked right) | `n===3` |
| 4 | `tiled` (2×2) | `n===4` |

`tmux select-layout -t csm-grid-<g> <layout>` — deterministic, no OS window math, no AX polling,
no multi-monitor handling. This is the entire tiling implementation.

### 7.8 Close — `POST /api/sessions/:id/close`
- Resolve pane → `tmux kill-pane -t <paneId>` (deterministically ends the claude process — removes
  the "did closing the window kill it?" ambiguity, so the `waitForPidExit` workaround can go).
- Grid now empty → `kill-session`. Else `selectLayout` to re-tile survivors.
- Update state; broadcast `session-patch running:null`.

### 7.9 Fork — `POST /api/sessions/:id/fork`
`claude --resume <sid> --fork-session` in a new pane/grid. Claude assigns the fork a new id; discover
it the same way `/clear` does (watch the pane's pid → new sid via `~/.claude/sessions` / pid-links),
then `setPaneOption(pane,'@csm_sid', newSid)`. Until discovered the pane is "sid pending" — the
reconciler must not reap it (§14).

### 7.10 Clear (`/clear` inside a session)
`reconcileClearedSessions` remaps old→new sid via pid-links (unchanged). **Addition:** when a remap
hits a live pane, update that pane's `@csm_sid` and the app map so quick-prompt/close/focus keep
targeting the right pane.

---

## 8. Terminal detection & launch

### 8.1 Which terminal — automatic, no chooser UI
Captured at **install time** (the installer runs in the user's terminal):
`setup.ts` reads `process.env.TERM_PROGRAM` (and `TERM` as backup), maps to an app name, saves to
`data/terminal.json`.

| `TERM_PROGRAM` | app | | `TERM` backup | app |
|---|---|---|---|---|
| `ghostty` | Ghostty | | `xterm-ghostty` | Ghostty |
| `iTerm.app` | iTerm | | `xterm-kitty` | kitty |
| `WarpTerminal` | Warp | | `alacritty` | Alacritty |
| `Apple_Terminal` | Terminal | | | |
| `WezTerm` | WezTerm | | | |
| `vscode` | *(fall back — not standalone)* | | | |

**Resolution chain:** saved value → scan `/Applications` for a known terminal → **Apple Terminal**
(guaranteed floor). Override via `CSM_TERMINAL=<AppName>`. No in-app chooser.

### 8.2 How the terminal is opened — small per-terminal launch-recipe table
Launching a *command* in an arbitrary terminal is not uniform; it needs each terminal's invocation.
This is a **small declarative table** (adding a terminal = a row), Apple Terminal is the fallback.
Every recipe runs the same command: `"<TMUX_BIN>" attach -t csm-grid-<g>` (with tmux status bar
hidden — see below).

| Terminal | Launch recipe (validate per terminal in impl, incl. "opens in the *running* instance") |
|---|---|
| Apple Terminal | write `attach-<g>.command`, `chmod +x`, `open -a Terminal <file>` |
| iTerm2 | `.command` + `open -a iTerm <file>` |
| Ghostty | `/Applications/Ghostty.app/Contents/MacOS/ghostty -e "<TMUX_BIN>" attach -t …` — **must reuse the running instance; NOT `open -na` (documented instance-duplication bug, `docs/ghostty-instance-bug-explainer.md`)** |
| kitty | `/Applications/kitty.app/Contents/MacOS/kitty "<TMUX_BIN>" attach -t …` |
| Alacritty | `…/alacritty -e "<TMUX_BIN>" attach -t …` |
| WezTerm | `wezterm start -- "<TMUX_BIN>" attach -t …` |
| Warp | limited command-on-launch support → **fall back to Apple Terminal** (§14). Managing the session still works fully; the user can also `tmux attach` manually in Warp. |

**Opening in an already-running terminal** (the user already has windows open): for
Terminal/iTerm, `open -a` opens a new window in the existing instance (clean). For Ghostty and
others, the recipe must add a window to the *running* instance (not spawn a duplicate app) — a
per-terminal validation item; Apple Terminal is the floor. Opening never disturbs the user's
existing windows; it adds a new one.

**Focus (bring to front) vs launch:** when a window is already attached (§7.2), we skip launch and
call `focusGridWindow` — exact-window raise (AX `AXRaise`, matched by the grid's session name in the
window title) for the terminals with a reliable recipe, falling back to plain `open -a "<terminal>"`
app-activation otherwise (§7.2).

**Dedicated socket + csm tmux config (decided):** every csm tmux invocation runs on its own socket
(`tmux -L csm -f data/tmux.conf …`) so server-wide settings never touch a tmux server the user runs
personally, nor their `~/.tmux.conf`. That config sets: `status off` (clean, native look — pane
tiling still shows tmux's thin pane borders, needed for the tiling), `mouse off` (deliberate — keeps
the terminal app's own native copy-paste working; dashboard-driven focus uses `select-pane` instead,
which needs no mouse mode), prefix-free `bind -n S-Left/S-Right/S-Up/S-Down select-pane -L/-R/-U/-D`
for keyboard pane switching, and `set-titles on` / `set-titles-string "#{session_name} #{pane_title}"`
for terminal title propagation (§7.6) — the embedded session name is also what `focusGridWindow`
(§7.2) matches on to raise the exact window. All of these are one-line flips if ever revisited (e.g. `mouse on`, or
rebinding Shift+Arrow if it collides with claude's own input handling).

---

## 9. Binary resolution (`TMUX_BIN`, `CLAUDE_BIN`) and shell

Both resolved once at startup, reusing the `CLAUDE_BIN` login-shell probe:
```
resolve(bin):
  if CSM_<BIN>_BIN env set → use it
  probe: $SHELL -lic 'whence -p <bin> || type -P <bin> || command -v <bin>'   (bypass fn/alias wrappers)
  else known dirs: ~/.local/bin, /opt/homebrew/bin, /usr/local/bin
  else bare "<bin>"
```
Rationale: launchd's PATH is minimal; tmux is usually `/opt/homebrew/bin/tmux` (not on launchd's
PATH). Panes run claude via `$LOGIN_SHELL -lic 'exec <CLAUDE_BIN> …'` (§6).

---

## 10. State, survival, and recovery

- **Survival:** tmux sessions persist across the app's launchd restart (every auto-update /
  `csm --update`), browser close, and terminal-window close. They do **not** survive a machine
  reboot (tmux server dies) — same as today; `claude --resume` recovers transcript state on next
  open. **Reboot recovery is lazy (decided): the app never auto-reopens sessions after a reboot;**
  each is resumed only when the user opens it.
- **Recovery on server startup** (replaces fragile window matching):
  1. `tmux list-panes -a -F '#{session_name}\t#{pane_id}\t#{@csm_sid}\t#{pane_pid}'` (+ `list-clients`).
  2. Rebuild grids + `sid → paneId` map + attached-state. A sid with a live pane = running.
  3. Reconcile `data/tmux-state.json`; tmux is canonical.
- **Orphan reconciliation** (replaces `orphanWatcher`): a periodic pass diffs live panes vs the map
  and broadcasts `running:null` for vanished sids. Must NOT reap "sid pending" fork panes (§7.9) or
  panes without `@csm_sid` (sessions the user started outside the app — ownership guard, mirrors
  the title-file guard shipped earlier).

### 10.1 Dashboard indicators — dot + chips (decided)

**Status dot — two states only:**
- **Green** = a terminal window is currently **attached** to the session's grid
  (`tmux list-clients -t <grid>` shows ≥1 client) — i.e. it's open on screen.
- **Grey** = no window attached (never opened, or the window was closed — even if the session is
  still running detached).
- Behavior: open/resume → attaches → green; close the window → detaches → grey (within one reconcile
  tick). This pairs with §7.2: **green dot → a click focuses the existing window; grey dot → a click
  opens a new one.**
- A running-but-detached session (e.g. a quick prompt working in the background with no window)
  shows **grey** — the dot means "window open," not "running." Activity is carried by the chip
  below, so no information is lost and the dot never lies about what it represents.

**Chips (activity/result on the card):**
- **Working chip** — shown while the session is actively working (busy), as today.
- **Done chip — exactly one, always the latest (decided):** show a single green "done" chip with
  the session's **most recent completed response**; a new completion **replaces** it, never stacks.
  (Implementation: keep at most one done chip per session and overwrite it, rather than appending.)
- **Waiting-for-user chip — distinct color (decided, if detectable):** when Claude Code signals it
  is **awaiting the user's input** (finished its turn and needs a reply, or a pending
  permission/question prompt), show a chip in a **separate color** (e.g. blue/violet, distinct from
  green "done" and amber "working") so the user sees at a glance which sessions need a response.
  Detection is wired from the session status file / transcript (e.g. status transitions to a
  waiting/idle-awaiting-input state, or a pending prompt marker). **Validate** that Claude Code
  exposes a reliable "waiting for user" signal; if it does not, omit this chip rather than guess.

---

## 11. Setup / install changes (`setup.ts`, `bootstrap.sh`)

- **Install tmux** instead of Ghostty: `brew install tmux` (best-effort, same shape as today's
  Ghostty install). tmux is a small headless CLI, not an app the user adopts.
- **Capture `TERM_PROGRAM`/`TERM`** → `data/terminal.json` (§8.1).
- **Remove** the Ghostty install step and the Accessibility/Automation permission-prompt flow.
- **Hard dependency (decided):** tmux is required for terminal features. If it cannot be installed
  (no Homebrew), the dashboard still runs and shows sessions read-only with a clear banner:
  *"Install tmux to launch and manage terminals: `brew install tmux`."* No silent breakage.

---

## 12. Migration / rollout

1. Land the tmux layer + terminal launcher behind the macOS platform check.
2. Switch `routes/*` call sites from `openTerminalRunning`/focus/close/inject to the tmux layer.
3. Delete Ghostty modules, title loop, orphan watcher, permissions route; update `setup.ts`.
4. Update docs (`docs/ghostty-instance-bug-explainer.md` → historical; add a tmux doc).
5. Ship via auto-updater / `csm --update`. Existing installs get tmux on next setup run — the server
   should also attempt tmux resolution/install on startup so an updated machine self-heals.

---

## 13. Edge cases & failure modes

| # | Case | Handling |
|---|------|----------|
| 1 | tmux missing / not on launchd PATH | `TMUX_BIN` resolution (§9); setup installs it; else read-only banner (§11) — never a crash |
| 2 | `claude` not resolvable in pane | absolute `CLAUDE_BIN` + login shell (§6) |
| 3 | Open a session that already has an attached window | focus existing (`select-pane` + `open -a`), no duplicate (§7.2) |
| 4 | Open a session that lives in one of **several** grid windows | `select-pane` targets the right pane; `focusGridWindow` raises that exact window on supported terminals, else app-activation only — never wrong session/duplicate (§7.2) |
| 5 | Close one pane of N | `kill-pane` + `select-layout` re-tile; empty grid → `kill-session` |
| 6 | 5th session while active grid has 4 | auto-spill into a new grid/window (§7.3) — not an error |
| 7 | `/clear` remaps sid on a live pane | reconcile updates pane `@csm_sid` + map (§7.10) |
| 8 | Fork's new sid not yet known | pane "sid pending"; reconciler skips it (§7.9) |
| 9 | Quick prompt, session not running | spin up attachable tmux session started on the prompt (§7.5) — openable/live immediately, no "wait until done" |
| 10 | Server restart (auto-update) mid-session | tmux keeps panes alive; startup recovery rebuilds map (§10) |
| 11 | Machine reboot | sessions gone; lazy — `--resume` recovers on next open (§10) |
| 12 | User `tmux attach`es manually from their own terminal | fine (same socket); reconciled as a live/attached pane; a pane without `@csm_sid` is not ours → never reaped |
| 13 | Session already running outside the app (manual, no tmux) | first-time duplicate is acceptable (decided); once it's an app-managed pane, subsequent opens focus it (§7.2) |
| 14 | Terminal has no "run command on open" (Warp) | fall back to Apple Terminal (§8.2); managing the session unaffected |
| 15 | `TERM_PROGRAM` unset (Alacritty/kitty) or generic (`vscode`/ssh) | fall back to `TERM` → `/Applications` scan → Terminal.app (§8.1) |
| 16 | Ghostty single-instance trap | recipe uses instance-reusing launch, never `open -na` (§8.2) |
| 17 | Two windows attached to one grid | tmux mirrors; size clamps to the smaller client. Minor; on Open we prefer focus over a new window (§7.2), so this is rare |
| 18 | `send-keys` prompt with quotes/newlines | `-l --` literal + separate `Enter`; collapse newlines |
| 19 | Pane index reuse after close | target by stable `#{pane_id}`, never index (§4) |
| 20 | Done chips stacking | keep exactly one done chip per session, overwrite on new completion (§10.1) |
| 21 | Stale sessions from an older app version | reconciler only manages the `csm-grid-*` namespace; ignores others |

---

## 14. Testing plan

- **Unit (bun test):** `grids.ts` mapping/reconciliation against a fake `listPanesAll`/`listClients`
  (sid→pane resolution; layout per count; empty-grid cleanup; auto-spill at 5; ownership guard;
  clear/fork remap; dot=attached derivation; single-done-chip logic). Terminal resolution chain
  (TERM_PROGRAM→app + fallbacks). No real tmux — inject a fake tmux runner.
- **Integration (real tmux, macOS):** drive via the API (see `docs/local-qa-and-testing.md`): start →
  `has-session`; add panes → pane count + layout; `send-keys` reached the pane (transcript grew);
  focus → `select-pane` moved the active pane; close → pane/session gone; kill the app mid-session →
  restart → recovery rebuilt the map; close window → dot grey; reopen → dot green.
- **Manual:** open in Ghostty, iTerm, Terminal (+ Warp fallback); tiling 1-4 + auto-spill; survival
  across `csm --update`; the waiting-for-user chip against real permission/idle states.

---

## 15. Resolved decisions

1. **tmux = the one hard dependency** (installed at setup; read-only banner if truly unavailable).
2. **Grids are ad-hoc**, not remembered across sessions.
3. **Tiling composition = auto-tile:** opening a different card adds a pane to the current grid up
   to **4**, then the 5th **spills into a new window/grid**.
4. **Focus:** Open focuses an existing attached window (`select-pane` for the exact session +
   `focusGridWindow` exact-window raise, falling back to plain `open -a` app-activation), no
   duplicate; a first-time duplicate is acceptable.
5. **Reboot recovery = lazy** (never auto-reopen).
6. **Terminal auto-detected** via `TERM_PROGRAM` at install; no chooser UI; Apple Terminal fallback.
7. **Quick prompt:** running (attached or detached) → `tmux send-keys`; not-running → attachable
   tmux session started on the prompt (native path).
8. **Status dot = 2 states:** green = a window is attached (open on screen); grey = none.
9. **Done chip:** exactly one, always the latest, never stacked.
10. **Waiting-for-user chip:** distinct color when Claude Code is awaiting input — *if* a reliable
    signal exists, else omitted.
11. **tmux status bar hidden**; **Warp → Apple Terminal fallback** if it can't be launched with a
    command (validate during implementation).

## 16. To validate during implementation
- `claude --resume <id> "<prompt>"` accepts an initial prompt in interactive mode (§7.5).
- Per-terminal "open a command window in the *running* instance" recipes, esp. Ghostty (no `-na`)
  and whether Warp has any usable launch hook (§8.2).
- A reliable Claude Code "waiting for user input" signal for the waiting chip (§10.1).
