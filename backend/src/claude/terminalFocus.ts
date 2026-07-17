// Bringing an already-open terminal window for a live session to the front, instead of spawning a
// duplicate — used by "Resume" (double-click on a running card) and as the fallback half of Quick
// Prompt's terminal-delivery path (see terminalInject.ts).
import { spawn } from "node:child_process";
import { pidAlive } from "../store.ts";
import { usingGhostty } from "./ghosttyEnv.ts";

function getTtyForPid(pid: number): Promise<string | null> {
  return new Promise((resolve) => {
    const child = spawn("ps", ["-o", "tty=", "-p", String(pid)], { stdio: ["ignore", "pipe", "ignore"] });
    let out = "";
    child.stdout.on("data", (d) => (out += d.toString()));
    child.on("close", () => {
      const tty = out.trim();
      resolve(tty && tty !== "??" ? tty : null);
    });
    child.on("error", () => resolve(null));
  });
}

// Requires Terminal Automation permission (System Settings → Privacy & Security → Automation)
// for whichever binary runs this server — unlike launching (which uses `open`, no permission
// needed), *finding* an existing tab means querying Terminal's window/tab list via AppleScript.
function focusExistingTerminalTab(tty: string): Promise<boolean> {
  const script = `
    tell application "Terminal"
      repeat with w in windows
        repeat with t in tabs of w
          if (tty of t) contains "${tty}" then
            set frontmost of w to true
            set selected tab of w to t
            activate
            return true
          end if
        end repeat
      end repeat
      return false
    end tell
  `;
  return new Promise((resolve) => {
    const child = spawn("osascript", ["-e", script], { stdio: ["ignore", "pipe", "ignore"] });
    let out = "";
    child.stdout.on("data", (d) => (out += d.toString()));
    child.on("close", () => resolve(out.trim() === "true"));
    child.on("error", () => resolve(false));
  });
}

// Ghostty has no custom AppleScript dictionary for tabs/ttys like Terminal.app, but it does expose
// its own window list via the standard Cocoa scripting suite (no Automation permission needed for
// a read-only "get name of every window" query — that's the same class of query System Preferences
// itself uses to list open windows). Every Ghostty window we launch is titled with
// ghosttyWindowTitle(...), which embeds ghosttyWindowTag(sessionId) as a bracketed suffix — so
// finding a window whose name *contains* that tag tells us this session already has a window open,
// and `activate` (also permission-free — the same verb `open -na` already performs) brings Ghostty
// to the front so the user lands on it directly instead of getting a duplicate/broken second
// `claude --resume` process.
function focusExistingGhosttyWindow(tag: string): Promise<boolean> {
  const script = `
    tell application "Ghostty"
      repeat with w in windows
        if (name of w) contains "${tag}" then
          activate
          return true
        end if
      end repeat
      return false
    end tell
  `;
  return new Promise((resolve) => {
    const child = spawn("osascript", ["-e", script], { stdio: ["ignore", "pipe", "ignore"] });
    let out = "";
    child.stdout.on("data", (d) => (out += d.toString()));
    child.on("close", () => resolve(out.trim() === "true"));
    child.on("error", () => resolve(false));
  });
}

// If this session has a live process, try to bring its existing terminal window to front instead
// of spawning a duplicate. Returns true if an existing window was found and focused.
export async function tryFocusRunningSession(pid: number, ghosttyTag?: string): Promise<boolean> {
  if (!pidAlive(pid)) return false;
  if (usingGhostty()) {
    return ghosttyTag ? focusExistingGhosttyWindow(ghosttyTag) : false;
  }
  const tty = await getTtyForPid(pid);
  if (!tty) return false;
  return focusExistingTerminalTab(tty);
}
