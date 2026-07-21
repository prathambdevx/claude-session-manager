> **Historical:** describes the old Ghostty-window auto-tiling, since replaced by tmux's own
> `select-layout` ladder (`docs/spec/2026-07-21-tmux-terminal-architecture.md` §7.7). Kept for context.

# Terminal auto-tiling

Every Ghostty terminal this app opens (New Task or Resume) reflows the app's own windows into a
layout as more are open — no manual arranging needed. All of it lives in
`backend/src/claude/terminal/terminalTile.ts`, wired in as one call at the end of
`terminalLaunch.ts`'s `openTerminalRunning()`.

## The layout

| Windows open | Layout |
|---|---|
| 1 | Untouched — wherever Ghostty's own default puts it |
| 2 | Left half / right half |
| 3 | Oldest gets the full-height left column; the other two stack top-right / bottom-right |
| 4 | All four quadrants filled (the left column splits into top-left / bottom-left) |
| 5+ | The newest is centered on top (65% × 75% of the screen); the first 4 are left as-is |

"Oldest"/"newest" is real open order, not window stacking order — see below.

## Only the app's own windows

Every window this app opens carries a `csm-<id8>` tag in its title (see `ghosttyWindowTag` in
`terminalLaunch.ts`). Tiling only ever touches windows whose title contains that tag — a Ghostty
window you opened yourself for something unrelated is never moved.

## Tracking real open order

System Events' own window list only reliably tells you one thing: which window is currently
frontmost (always the one that was just created). The relative order of the *rest* of the windows
in that list isn't dependable enough to build a layout from.

So open order is tracked explicitly in a small persisted file, `data/ghostty-window-order.json` —
a plain array of tags, oldest first. Each retile:
1. Drops any tag no longer open (its window was closed).
2. Appends any currently-open tag missing from the list (predates the file, or wasn't the
   just-created one) — true age unknowable, so it just needs to land before the new one.
3. Appends the just-opened tag last — it's definitionally the newest, so it's never left to
   System Events' own enumeration order to decide.

## Multi-monitor: tiles on whichever screen the oldest window is on

Plain AppleScript/Finder can only ever report the *primary* display's bounds — there's no vanilla
way to enumerate every connected screen. Getting the real per-monitor frames needs JXA (JavaScript
for Automation, `osascript -l JavaScript`), which can reach into AppKit directly:
`ObjC.import("AppKit"); $.NSScreen.screens`.

Each retile fetches every screen's frame this way, finds which one contains the **oldest** tracked
window's current position, and tiles within that screen's bounds — so a terminal already sitting
on an external monitor stays there instead of being pulled back onto the primary display.

Two coordinate-space details that matter here:
- NSScreen's y-axis grows **upward** from the primary screen's bottom edge; AppleScript's
  `position of window` grows **downward** from the primary screen's top edge. Every screen frame is
  converted to this window-position space before being compared against a window's current
  position — comparing the two spaces directly would silently pick the wrong screen.
- Screen frames are the **raw** `.frame`, not `.visibleFrame`. The OS already clamps a requested
  window position away from the menu bar on its own — accounting for that inset a second time here
  would double-subtract it.

## Ghostty's AX window list populates lazily

`tell application "System Events" to tell process "ghostty" to windows` only returns real windows
after Ghostty has been `activate`d — before that, whether it's in the foreground or not, the list
comes back empty. Every separate `osascript` process this feature spawns re-activates Ghostty and
polls briefly before reading/writing window state — skipping that in any one of them silently
no-ops whatever that script was trying to do, with no error.

## Known limitation

Screen detection has only been verified against a single physical display. The mechanism (point-
in-rect matching against real per-monitor frames) is sound, but hasn't been confirmed against an
actual external monitor.
