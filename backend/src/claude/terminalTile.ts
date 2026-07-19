// Auto-tiling for the Ghostty windows this app itself opens — whenever a new one appears, the
// currently-open csm-tagged windows reflow into a quadrant grid instead of stacking wherever
// Ghostty defaults to. Runs as its own background task after openTerminalRunning spawns the new
// window; never awaited by the launch route, so it adds no latency to the HTTP response.
import { spawn } from "node:child_process";
import { GHOSTTY_WINDOW_ORDER_PATH } from "../constants.ts";

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

// Ghostty populates System Events' AX window list lazily, only after activation — same quirk
// documented in docs/ghostty-instance-bug-explainer.md for the focus/raise path. Polls until the
// just-created window's own tag shows up before reading the rest of the list.
async function liveGhosttyWindowTitles(newTag: string): Promise<string[]> {
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
      set out to out & (name of w) & linefeed
    end repeat
    return out
  end tell
end tell
  `);
  return out.split("\n").map((s) => s.trim()).filter(Boolean);
}

function tagFromTitle(title: string): string | null {
  return title.match(/csm-[0-9a-f]{8}/)?.[0] ?? null;
}

// One position+size assignment, matched by tag substring (not full title) — sidesteps escaping an
// arbitrary session name, and mirrors the substring-match style already proven in terminalFocus.ts.
function placeByTag(tag: string, x: string, y: string, w: string, h: string): string {
  return `
    repeat with w in windows
      if (name of w) contains "${tag}" then
        set position of w to {${x}, ${y}}
        set size of w to {${w}, ${h}}
        exit repeat
      end if
    end repeat`;
}

/**
 * Positions this app's own Ghostty windows into a quadrant grid, oldest-opened first — 1st/2nd
 * split left/right, 3rd/4th fill the bottom two quadrants, a 5th+ is centered on top instead
 * (leaving the first 4 untouched). Silently no-ops if the new window never actually appeared.
 */
export async function retileGhosttyWindows(newTag: string): Promise<void> {
  const titles = await liveGhosttyWindowTitles(newTag);
  const liveTags = new Set(titles.map(tagFromTitle).filter((t): t is string => t != null));
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

  let body = "";
  if (n === 2) {
    body += placeByTag(ordered[0], "sx", "sy", "sw / 2", "sh");
    body += placeByTag(ordered[1], "sx + sw / 2", "sy", "sw / 2", "sh");
  } else if (n === 3) {
    body += placeByTag(ordered[0], "sx", "sy", "sw / 2", "sh / 2");
    body += placeByTag(ordered[1], "sx + sw / 2", "sy", "sw / 2", "sh / 2");
    body += placeByTag(ordered[2], "sx", "sy + sh / 2", "sw / 2", "sh / 2");
  } else if (n === 4) {
    body += placeByTag(ordered[0], "sx", "sy", "sw / 2", "sh / 2");
    body += placeByTag(ordered[1], "sx + sw / 2", "sy", "sw / 2", "sh / 2");
    body += placeByTag(ordered[2], "sx", "sy + sh / 2", "sw / 2", "sh / 2");
    body += placeByTag(ordered[3], "sx + sw / 2", "sy + sh / 2", "sw / 2", "sh / 2");
  } else {
    body += placeByTag(ordered[n - 1], "sx + sw * 0.175", "sy + sh * 0.125", "sw * 0.65", "sh * 0.75");
  }

  const script = `
tell application "Finder" to set screenBounds to bounds of window of desktop
set sx to item 1 of screenBounds
set sy to item 2 of screenBounds
set sw to (item 3 of screenBounds) - sx
set sh to (item 4 of screenBounds) - sy
tell application "System Events"
  tell process "ghostty"${body}
  end tell
end tell
  `;
  spawn("osascript", ["-e", script], { stdio: "ignore", detached: true }).unref();
}
