# Why "Resume" opened duplicate terminals — an OS-level explainer

**Purpose of this doc:** enough context for a fresh Claude session (with no memory of the
investigation) to build a proper illustrated HTML explainer (diagrams + walkthrough) of this bug,
without needing to re-derive the OS concepts from scratch. This doc is the source material, not the
final deliverable — the deliverable is an HTML page built FROM this.

## The one-sentence bug

Every terminal launch used `open -na Ghostty.app`, and the `-n` flag means **"always start a
brand-new instance of this app"** — so every single "Resume" or "New Task" click spawned an
entirely separate Ghostty *process*, not a new window in the one already running. Over normal use
this silently produced a dozen+ separate Ghostty processes, and our own "is this session's terminal
already open?" check could only ever see windows belonging to ONE of them.

## Background concepts an illustration needs to cover

### 1. Process vs. window (the normal case)
A native Mac app is **one process that can own many windows** — a browser, a text editor, Finder.
That's the default, expected shape. Opening "File → New Window" doesn't start a second copy of the
program; the same running process just creates another window. Internally that process may use
multiple threads to render each window, but from the OS's point of view there is one thing running:
one PID, one entry in Activity Monitor, one Dock icon.

**Diagram idea:** one big rounded box labeled "Ghostty (1 process, PID 3215)" containing 3 small
window rectangles inside it.

### 2. What `open -n` actually instructs
`open` is a macOS command that hands a launch request to **Launch Services** (the OS subsystem that
resolves "open this app / file" requests). Its `-n` flag is a direct instruction: *do not attach
this request to a copy of the app that's already running — start a fresh one regardless.* This
flag exists for legitimate reasons (e.g., some sandboxed automation wants a clean, isolated
instance), but used on every single terminal launch it means: **every launch = a brand-new
process.**

**Diagram idea:** a timeline/sequence showing "Launch 1 → Ghostty PID A", "Launch 2 (open -na
again) → Ghostty PID B", "Launch 3 → Ghostty PID C" — three separate boxes, not one box gaining
windows.

### 3. What we actually found on the real machine (concrete evidence, use these exact numbers)
Live investigation during this session found:
- **12 separate `ghostty` OS processes**, e.g. PIDs `3215, 3809, 5196, 5449, 23448, 27468, 27777,
  83621, 87718, 93292, 96408, 96409` — every one with **PPID (parent process id) = 1**, meaning
  each was launched directly by `launchd` as its own top-level instance, not spawned as a child of
  another Ghostty process. Confirms: 12 independent instances, not one app with 12 windows.
- **14 live interactive `claude --resume ...` processes** running at the same time (real, active
  work sessions).
- Yet `osascript -e 'tell application "Ghostty" to count windows'` returned **1**. Not 14, not 12 —
  exactly one, because AppleScript's `tell application "Ghostty"` can only ever address a single
  process, and it picked whichever one instance macOS resolves the name to.

This is the smoking gun: 14 real sessions existed, but our own focus-check script could only ever
see the windows that happened to belong to ONE of the 12 running Ghostty processes. The other ~13
sessions' windows were **structurally invisible** to it — not "hard to find," but categorically
unreachable from that script, no matter how the search logic inside it was written.

### 4. Why AppleScript couldn't just "loop over all the PIDs instead"
This is the part worth spending the most illustration effort on, since it's the least intuitive.

AppleScript talks to applications via **Apple Events**, and the everyday syntax —
`tell application "Ghostty"` — addresses a target by **application name** (or bundle identifier),
not by PID. This model was designed around the normal case (section 1): one process per app. When
multiple processes happen to share the exact same name, there is no clean, documented way in plain
AppleScript to say "the second one" or "PID 27468 specifically, not PID 96408." The Apple Event
Manager just resolves the name to *some* running copy — which one is essentially undefined
behavior from the caller's perspective.

There does exist a lower-level mechanism for targeting a specific PID
(`NSAppleEventDescriptor(processIdentifier:)`), but that requires writing and compiling a small
native Objective-C/Swift helper — it is **not reachable from a plain shell-level `osascript -e
"<script text>"` call**, which is the only mechanism this codebase uses to talk to Ghostty
(see `backend/src/claude/terminalFocus.ts`, `terminalLaunch.ts`). The generic UI-scripting bridge
(`tell application "System Events" to tell process "Ghostty"`) can distinguish multiple
same-named processes in its process list, but it can only simulate clicks/keystrokes — it cannot
invoke Ghostty's own custom scripting commands (`new window`, `tabs of window`, etc.) on a specific
one of several instances. Those custom commands are only reachable via `tell application
"Ghostty"` by name, which is exactly the address that can't disambiguate multiple copies.

**Diagram idea:** two side-by-side boxes.
- Left, labeled "✕ What we'd need for a per-PID loop": an arrow from a script to "Ghostty PID
  27468" specifically, bypassing the other 11 — annotate "not expressible in plain AppleScript
  text; would need a compiled native helper using low-level Apple Event target descriptors."
- Right, labeled "the actual fix": one arrow from the script straight to "the one Ghostty
  process" (no ambiguity possible because there's only one).

**Diagram idea 2 (sequence):** "Script sends `tell application \"Ghostty\"`" → "Apple Event
Manager resolves name → PID?" → shrug icon / "ambiguous, picks one" — vs. after the fix, the same
arrow with no fork at all.

### 5. The fix, in one picture
- **Before:** `openTerminalRunning()` called `open -na Ghostty.app --args ...` on every launch.
  Each call = new process. `focusExistingGhosttyWindow()` (in `terminalFocus.ts`) searches `tell
  application "Ghostty" → windows → tabs → name contains <tag>` — but that search only ever reaches
  whichever ONE of the N processes AppleScript resolved to.
- **After:** `openTerminalRunning()` sends Ghostty's own native AppleScript command instead of
  `open -na`:
  ```applescript
  tell application "Ghostty"
    set cfg to new surface configuration
    set command of cfg to "zsh <path-to-launch-script>"
    set win to new window with configuration cfg
    activate
  end tell
  ```
  This asks the *already-running* instance to open a new window — the same internal action Ghostty
  performs when a user presses ⌘N — so no new process is ever created. Every session's window ends
  up owned by the same single process, and the exact same `focusExistingGhosttyWindow()` search
  that existed before now actually works, because there's only one instance for `tell application
  "Ghostty"` to mean.

**Diagram idea:** before/after comparison —
- Before: 4 separate rounded boxes (PID A, B, C, D), each with one window inside, a magnifying-glass
  icon only touching box A (representing the focus script), red X on boxes B/C/D.
- After: 1 rounded box (single PID) containing 4 window rectangles, magnifying glass touching the
  whole box, green check on all 4 windows.

### 6. Supporting evidence worth citing verbatim in the illustrated version
- `ps -eo pid,ppid,comm | grep -i "MacOS/ghostty"` → 12 rows, all `ppid=1`.
- `osascript -e 'tell application "Ghostty" to count windows'` → `1` (while 14 sessions were live).
- After the fix, a live test: creating a new window via the native AppleScript command, then
  immediately re-querying `tell application "Ghostty" to get name of every window`, returned BOTH
  the pre-existing window's title AND the newly created one — proof the new window landed in the
  same scriptable instance instead of a new invisible one.

## Files involved (for the session building the HTML to reference, not to re-read from scratch)
- `backend/src/claude/terminalLaunch.ts` — `openTerminalRunning()`, the launcher (this is where
  `open -na` was replaced).
- `backend/src/claude/terminalFocus.ts` — `focusExistingGhosttyWindow()`, the search/focus logic
  (unchanged in its core idea, now searches tabs within windows too since sessions can be tabs OR
  windows).
- `backend/src/routes/sessions.ts` — the `/resume` route that decides focus-vs-launch.

## What the HTML deliverable should probably include
1. A short "the bug in one sentence" hero statement.
2. Section 1–2 concepts (process vs window, what `-n` does) as a simple before/after diagram.
3. The concrete evidence from section 4 (real numbers, not hypothetical) — this makes it feel like
   a real investigation, not a textbook explainer.
4. The AppleScript addressing limitation (section 4) as the "aha" — this is the least intuitive
   part and deserves the most visual care, probably a small interactive toggle between "naive
   per-PID loop (doesn't work)" and "the actual fix (works)."
5. The before/after box diagram from section 5 as the closing visual.
6. Keep tone plain and concrete — this was a real bug on a real machine with real numbers, not a
   generic OS lecture.

## Follow-up: raising the RIGHT window to the front (double-tap "focus")

Once every session lands in the single scriptable instance (above), a second, separate problem
surfaced: double-tapping a session in the UI selected the right tab and put the cursor there, but
the window itself often stayed *behind* other Ghostty windows. Two more OS quirks, both confirmed
live, explain it — the fix lives in `focusExistingGhosttyWindow()` (`terminalFocus.ts`):

1. **Ghostty's own `activate window w` doesn't reliably reorder windows on screen.** `activate` is a
   standard *app-level* AppleScript verb (bring the whole app forward), but activating one specific
   *window object* isn't part of core AppleScript vocabulary the way app-level activation is, and
   Ghostty's dictionary doesn't implement it as a real reorder. So plain `activate` brought Ghostty
   forward to whichever window it last considered current — often the wrong one. The reliable path
   is System Events' Accessibility action **`AXRaise`** on that specific window (OS window-server
   level), which is the same class of thing Terminal.app gets for free via `set frontmost of w`.

2. **Ghostty populates its Accessibility window list LAZILY — only after the app is activated.**
   Confirmed live: with Ghostty in the background, `tell application "System Events" to tell process
   "ghostty" to count windows` returns **0**, while Ghostty's own dictionary returns the real count
   (e.g. 5). After `tell application "Ghostty" to activate` + a short delay, System Events then sees
   all of them. So the working sequence is: select the tab + focus its terminal (Ghostty dictionary)
   → `activate` the app → poll until the AX window list is non-empty → `AXRaise` the matching window.

Two smaller gotchas found while debugging this, both of which silently no-op'd earlier attempts:
- **The process name is lowercase `ghostty`** (it matches the running binary), and System Events
  process names are **case-sensitive** — `tell process "Ghostty"` (capital G) matches nothing.
- **Return "found the tab", not "AXRaise succeeded".** The resume route launches a NEW terminal when
  focus returns false, so if AXRaise ever fails (e.g. Accessibility permission not granted) the
  function must still report success on having found the window, or it would spawn a duplicate.
