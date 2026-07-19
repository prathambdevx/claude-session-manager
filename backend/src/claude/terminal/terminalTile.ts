// Auto-tiling for the Ghostty windows this app itself opens — whenever a new one appears, the
// currently-open csm-tagged windows reflow into a quadrant grid instead of stacking wherever
// Ghostty defaults to. Runs as its own background task after openTerminalRunning spawns the new
// window; never awaited by the launch route, so it adds no latency to the HTTP response.
import { spawn } from "node:child_process";
import { GHOSTTY_WINDOW_ORDER_PATH } from "../../constants.ts";

async function loadWindowOrder(): Promise<string[]> {
  try {
    return await Bun.file(GHOSTTY_WINDOW_ORDER_PATH).json();
  } catch {
    return [];
  }
}
async function saveWindowOrder(tags: string[]): Promise<void> {
  await Bun.write(GHOSTTY_WINDOW_ORDER_PATH, JSON.stringify(tags));
}

function runAppleScript(script: string): Promise<string> {
  return new Promise((resolve) => {
    const child = spawn("osascript", ["-e", script], { stdio: ["ignore", "pipe", "ignore"] });
    let out = "";
    child.stdout.on("data", (d) => (out += d.toString()));
    child.on("close", () => resolve(out.trim()));
    child.on("error", () => resolve(""));
  });
}

type WindowInfo = { title: string; x: number; y: number };

// Ghostty populates System Events' AX window list lazily, only after activation — same quirk
// documented in docs/ghostty-instance-bug-explainer.md for the focus/raise path. Polls until the
// just-created window's own tag shows up, then returns every open window's title + current
// position (the position doubles as the "which screen is this on" signal below).
async function liveGhosttyWindows(newTag: string): Promise<WindowInfo[]> {
  const out = await runAppleScript(`
tell application "Ghostty" to activate
delay 0.2
tell application "System Events"
  tell process "ghostty"
    set tries to 0
    set found to false
    repeat while (tries < 10) and not found
      set found to false
      repeat with w in windows
        if (name of w) contains "${newTag}" then
          set found to true
          exit repeat
        end if
      end repeat
      if not found then
        delay 0.15
        set tries to tries + 1
      end if
    end repeat
    set out to ""
    repeat with w in windows
      set p to position of w
      set out to out & (name of w) & "\\t" & (item 1 of p) & "\\t" & (item 2 of p) & linefeed
    end repeat
    return out
  end tell
end tell
  `);
  return out.split("\n").map((s) => s.trim()).filter(Boolean).map((line) => {
    const [title, x, y] = line.split("\t");
    return { title, x: Number(x), y: Number(y) };
  });
}

type ScreenFrame = { x: number; y: number; w: number; h: number };

// Every connected display's raw frame, in the same global point-space AppleScript window
// positions use — vanilla AppleScript/Finder only ever exposes the *primary* screen's bounds, so
// this needs JXA's NSScreen bridge instead. `.frame`, not `.visibleFrame` — the OS already clamps a
// requested position away from the menu bar on its own (confirmed live), so accounting for that
// inset here too would double-subtract it.
async function screenFrames(): Promise<ScreenFrame[]> {
  const out = await new Promise<string>((resolve) => {
    const child = spawn("osascript", ["-l", "JavaScript", "-e", `
ObjC.import("AppKit");
var screens = $.NSScreen.screens;
var out = [];
for (var i = 0; i < screens.count; i++) {
  var f = screens.objectAtIndex(i).frame;
  out.push(f.origin.x + "," + f.origin.y + "," + f.size.width + "," + f.size.height);
}
out.join("\\n");
    `], { stdio: ["ignore", "pipe", "ignore"] });
    let buf = "";
    child.stdout.on("data", (d) => (buf += d.toString()));
    child.on("close", () => resolve(buf.trim()));
    child.on("error", () => resolve(""));
  });
  return out.split("\n").map((s) => s.trim()).filter(Boolean).map((line) => {
    const [x, y, w, h] = line.split(",").map(Number);
    return { x, y, w, h };
  });
}

// NSScreen's y-axis grows upward from the primary screen's bottom edge, while AppleScript window
// positions grow downward from the primary screen's top edge — same global space, opposite y
// direction. Converts one screen's frame into window-position coordinates (top-left origin).
function toWindowSpace(frame: ScreenFrame, primaryHeight: number): ScreenFrame {
  return { x: frame.x, y: primaryHeight - frame.y - frame.h, w: frame.w, h: frame.h };
}

function tagFromTitle(title: string): string | null {
  return title.match(/csm-[0-9a-f]{8}/)?.[0] ?? null;
}

// One position+size assignment, matched by tag substring (not full title) — sidesteps escaping an
// arbitrary session name, and mirrors the substring-match style already proven in terminalFocus.ts.
function placeByTag(tag: string, x: number, y: number, w: number, h: number): string {
  return `
    repeat with w in windows
      if (name of w) contains "${tag}" then
        set position of w to {${Math.round(x)}, ${Math.round(y)}}
        set size of w to {${Math.round(w)}, ${Math.round(h)}}
        exit repeat
      end if
    end repeat`;
}

/**
 * Positions this app's own Ghostty windows into a quadrant grid, oldest-opened first — 1st/2nd
 * split left/right, 3rd/4th fill the bottom two quadrants, a 5th+ is centered on top instead
 * (leaving the first 4 untouched). Tiles within whichever screen the oldest (1st-opened) window is
 * currently on, so an external monitor's windows stay on that monitor rather than being pulled
 * back onto the primary display. Silently no-ops if the new window never actually appeared.
 */
export async function retileGhosttyWindows(newTag: string): Promise<void> {
  const windows = await liveGhosttyWindows(newTag);
  const liveTags = new Set(windows.map((w) => tagFromTitle(w.title)).filter((t): t is string => t != null));
  if (!liveTags.has(newTag)) return;

  // Persisted order, pruned to windows that are actually still open. Any other live tag missing
  // from it (predates this order file) is appended next — its true age is unknowable, so it just
  // needs to land somewhere before newTag. newTag itself always goes last: it's definitionally the
  // newest, so it must never be decided by System Events' own (untrustworthy) enumeration order.
  const persisted = await loadWindowOrder();
  const ordered = persisted.filter((t) => liveTags.has(t));
  for (const t of liveTags) if (t !== newTag && !ordered.includes(t)) ordered.push(t);
  if (!ordered.includes(newTag)) ordered.push(newTag);
  await saveWindowOrder(ordered);

  const n = ordered.length;
  if (n < 2) return;

  const frames = await screenFrames();
  const primary = frames[0]; // NSScreen.screens[0] is always the primary/menu-bar display
  // Converted to window-position coordinates up front, so the containment check below compares
  // like with like — oldestPos already comes from `position of window`, the same space.
  const screensInWindowSpace = primary ? frames.map((f) => toWindowSpace(f, primary.h)) : [];
  const oldestPos = windows.find((w) => tagFromTitle(w.title) === ordered[0]);
  // Whichever screen contains the oldest window's current top-left corner — falls back to the
  // primary display if that lookup ever comes up empty (e.g. a screen was just unplugged).
  const { x: sx, y: sy, w: sw, h: sh } = (oldestPos && screensInWindowSpace.find((f) =>
    oldestPos.x >= f.x && oldestPos.x < f.x + f.w && oldestPos.y >= f.y && oldestPos.y < f.y + f.h,
  )) || screensInWindowSpace[0] || { x: 0, y: 0, w: 1440, h: 900 };

  let body = "";
  if (n === 2) {
    body += placeByTag(ordered[0], sx, sy, sw / 2, sh);
    body += placeByTag(ordered[1], sx + sw / 2, sy, sw / 2, sh);
  } else if (n === 3) {
    body += placeByTag(ordered[0], sx, sy, sw / 2, sh / 2);
    body += placeByTag(ordered[1], sx + sw / 2, sy, sw / 2, sh / 2);
    body += placeByTag(ordered[2], sx, sy + sh / 2, sw / 2, sh / 2);
  } else if (n === 4) {
    body += placeByTag(ordered[0], sx, sy, sw / 2, sh / 2);
    body += placeByTag(ordered[1], sx + sw / 2, sy, sw / 2, sh / 2);
    body += placeByTag(ordered[2], sx, sy + sh / 2, sw / 2, sh / 2);
    body += placeByTag(ordered[3], sx + sw / 2, sy + sh / 2, sw / 2, sh / 2);
  } else {
    body += placeByTag(ordered[n - 1], sx + sw * 0.175, sy + sh * 0.125, sw * 0.65, sh * 0.75);
  }

  // This positioning script is a separate osascript process from the one that just polled/
  // activated Ghostty above — if anything else became frontmost in between (even briefly), the AX
  // window list can go stale again for THIS process too, silently no-opping every placeByTag match
  // below. Re-activating here guarantees the list is populated for this script specifically.
  const script = `
tell application "Ghostty" to activate
delay 0.15
tell application "System Events"
  tell process "ghostty"${body}
  end tell
end tell
  `;
  spawn("osascript", ["-e", script], { stdio: "ignore", detached: true }).unref();
}
