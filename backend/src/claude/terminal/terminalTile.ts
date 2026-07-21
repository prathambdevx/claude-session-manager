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
// inset here too would double-subtract it. The mouse's current location rides along in the same
// call (one osascript process instead of two) — it decides which screen to tile onto below.
async function screenFramesAndMouse(): Promise<{ frames: ScreenFrame[]; mouse: { x: number; y: number } | null }> {
  const out = await new Promise<string>((resolve) => {
    const child = spawn("osascript", ["-l", "JavaScript", "-e", `
ObjC.import("AppKit");
var screens = $.NSScreen.screens;
var out = [];
for (var i = 0; i < screens.count; i++) {
  var f = screens.objectAtIndex(i).frame;
  out.push(f.origin.x + "," + f.origin.y + "," + f.size.width + "," + f.size.height);
}
var m = $.NSEvent.mouseLocation;
out.push("mouse:" + m.x + "," + m.y);
out.join("\\n");
    `], { stdio: ["ignore", "pipe", "ignore"] });
    let buf = "";
    child.stdout.on("data", (d) => (buf += d.toString()));
    child.on("close", () => resolve(buf.trim()));
    child.on("error", () => resolve(""));
  });
  const frames: ScreenFrame[] = [];
  let mouse: { x: number; y: number } | null = null;
  for (const line of out.split("\n").map((s) => s.trim()).filter(Boolean)) {
    if (line.startsWith("mouse:")) {
      const [x, y] = line.slice(6).split(",").map(Number);
      mouse = { x, y };
    } else {
      const [x, y, w, h] = line.split(",").map(Number);
      frames.push({ x, y, w, h });
    }
  }
  return { frames, mouse };
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
// x/y/w/h are raw AppleScript expressions, not just numbers — placeByTag below is the common case
// (plain numeric literals); a stacked row's second window instead passes an expression built from
// the first window's own *actual* resulting position, captured below by placeByTagCapture.
function placeByTagExpr(tag: string, x: string, y: string, w: string, h: string): string {
  return `
    repeat with w in windows
      if (name of w) contains "${tag}" then
        set position of w to {${x}, ${y}}
        set size of w to {${w}, ${h}}
        exit repeat
      end if
    end repeat`;
}

function placeByTag(tag: string, x: number, y: number, w: number, h: number): string {
  return placeByTagExpr(tag, String(Math.round(x)), String(Math.round(y)), String(Math.round(w)), String(Math.round(h)));
}

// Same as placeByTag, but also captures the window's post-set position/size into the given
// AppleScript variable names — macOS can silently clamp a requested position (e.g. away from going
// negative near the menu bar) without resizing the window, so a second window stacked below this
// one must be placed from what actually happened here, not the value that was requested.
function placeByTagCapture(tag: string, x: number, y: number, w: number, h: number, posVar: string, sizeVar: string): string {
  return `
    repeat with w in windows
      if (name of w) contains "${tag}" then
        set position of w to {${Math.round(x)}, ${Math.round(y)}}
        set size of w to {${Math.round(w)}, ${Math.round(h)}}
        set ${posVar} to position of w
        set ${sizeVar} to size of w
        exit repeat
      end if
    end repeat`;
}

/**
 * Positions this app's own Ghostty windows into a quadrant grid, oldest-opened first — 1st/2nd
 * split left/right, 3rd/4th fill the bottom two quadrants, a 5th+ is centered on top instead
 * (leaving the first 4 untouched). Tiles onto whichever screen the mouse is currently on, so a new
 * terminal (and the group it joins) follows you to whatever monitor you're actively working on.
 * Silently no-ops if the new window never actually appeared.
 */
export async function retileGhosttyWindows(newTag: string): Promise<void> {
  if (process.platform !== "darwin") return;
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

  const { frames, mouse } = await screenFramesAndMouse();
  const primary = frames[0]; // NSScreen.screens[0] is always the primary/menu-bar display
  // Converted to window-position coordinates up front, so the containment check below compares
  // like with like — the mouse point gets the same treatment just below.
  const screensInWindowSpace = primary ? frames.map((f) => toWindowSpace(f, primary.h)) : [];
  const mouseInWindowSpace = mouse && primary ? { x: mouse.x, y: primary.h - mouse.y } : null;
  // Whichever screen currently contains the mouse — falls back to the primary display if that
  // lookup ever comes up empty (e.g. the cursor is momentarily between displays, or JXA failed).
  const { x: sx, y: sy, w: sw, h: sh } = (mouseInWindowSpace && screensInWindowSpace.find((f) =>
    mouseInWindowSpace.x >= f.x && mouseInWindowSpace.x < f.x + f.w && mouseInWindowSpace.y >= f.y && mouseInWindowSpace.y < f.y + f.h,
  )) || screensInWindowSpace[0] || { x: 0, y: 0, w: 1440, h: 900 };

  let body = "";
  if (n === 1) {
    body += placeByTag(ordered[0], sx + sw * 0.175, sy + sh * 0.125, sw * 0.65, sh * 0.75);
  } else if (n === 2) {
    body += placeByTag(ordered[0], sx, sy, sw / 2, sh);
    body += placeByTag(ordered[1], sx + sw / 2, sy, sw / 2, sh);
  } else if (n === 3) {
    // Oldest gets the full-height left column (like the 2-window case), the other two stack in
    // the right half — not a plain 2x2 grid, since there's no 4th window yet to fill it out. The
    // bottom-right window's y/height come from the top-right window's real post-clamp result.
    body += placeByTag(ordered[0], sx, sy, sw / 2, sh);
    body += placeByTagCapture(ordered[1], sx + sw / 2, sy, sw / 2, sh / 2, "p1", "s1");
    body += `
    set bottomY to (item 2 of p1) + (item 2 of s1)
    set bottomH to ${Math.round(sy + sh)} - bottomY`;
    body += placeByTagExpr(ordered[2], String(Math.round(sx + sw / 2)), "bottomY", String(Math.round(sw / 2)), "bottomH");
  } else if (n === 4) {
    // Bottom row's y/height come from the top-left window's real post-clamp result, the same fix
    // as the n===3 case above.
    body += placeByTagCapture(ordered[0], sx, sy, sw / 2, sh / 2, "p0", "s0");
    body += placeByTag(ordered[1], sx + sw / 2, sy, sw / 2, sh / 2);
    body += `
    set bottomY to (item 2 of p0) + (item 2 of s0)
    set bottomH to ${Math.round(sy + sh)} - bottomY`;
    body += placeByTagExpr(ordered[2], String(Math.round(sx)), "bottomY", String(Math.round(sw / 2)), "bottomH");
    body += placeByTagExpr(ordered[3], String(Math.round(sx + sw / 2)), "bottomY", String(Math.round(sw / 2)), "bottomH");
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
