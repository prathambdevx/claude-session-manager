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

// Searches windows AND their tabs (not just window names) — a background tab's title is invisible
// to a window-name-only search. See docs/ghostty-instance-bug-explainer.md.
function focusExistingGhosttyWindow(tag: string): Promise<boolean> {
  const script = `
    tell application "Ghostty"
      repeat with w in windows
        repeat with t in tabs of w
          if (name of t) contains "${tag}" then
            try
              set selected tab of w to t
            end try
            try
              focus (focused terminal of t)
            end try
            activate window w
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

// Try to bring this session's existing terminal window to front instead of spawning a duplicate.
export async function tryFocusRunningSession(pid: number | null, ghosttyTag?: string): Promise<boolean> {
  // Ghostty matches by the session's csm-<id8> title tag, never by pid — Claude Code leaves
  // stale/orphaned pid files that would wrongly veto a real focus.
  if (usingGhostty()) {
    return ghosttyTag ? focusExistingGhosttyWindow(ghosttyTag) : false;
  }
  // Terminal.app has no tag-based lookup — falls back to matching by tty, which needs a live pid.
  if (pid == null || !pidAlive(pid)) return false;
  const tty = await getTtyForPid(pid);
  if (!tty) return false;
  return focusExistingTerminalTab(tty);
}
