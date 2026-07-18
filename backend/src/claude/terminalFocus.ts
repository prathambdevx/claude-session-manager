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

// Every window/tab we launch carries ghosttyWindowTag(sessionId) as a bracketed suffix in its
// title (set live by the OSC title loop), so finding one whose name *contains* that tag means this
// session already has a terminal open. We search at the TAB level, not just window names: sessions
// can be separate windows OR tabs merged into one window, and a window's own `name` only reflects
// its *active* tab — a background tab would be missed by a window-name-only search (this, combined
// with the old `open -na` multi-instance bug, is why Resume used to spawn duplicates). Now that all
// launches land in the single scriptable instance (see openTerminalRunning), enumerating its
// windows → tabs finds every session. On a match we raise that exact tab: select it within its
// window, focus its terminal, and bring Ghostty to the front. All of this is permission-wise the
// same class as the `activate` we already relied on.
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
// Returns true if an existing window was found and focused.
//
// For Ghostty, the window is matched by the csm-<id8> TAG in its title — which is derived from the
// SESSION ID, not the pid. The window's existence is therefore the authoritative "is this session
// already open" signal, and it deliberately does NOT gate on the pid: Claude Code leaves multiple
// stale ~/.claude/sessions/<pid>.json files per session (lazy cleanup), and headless runs (Quick
// Prompt) spawn windowless pid files that are often the newest — so any pid picked from that data
// can be stale/orphaned/windowless and wrongly veto a focus that would otherwise succeed. Passing
// pid=null (the normal case for the Ghostty resume path) skips the pid entirely.
//
// The Terminal.app fallback still needs the pid — it matches by tty, which only a live process has.
export async function tryFocusRunningSession(pid: number | null, ghosttyTag?: string): Promise<boolean> {
  if (usingGhostty()) {
    return ghosttyTag ? focusExistingGhosttyWindow(ghosttyTag) : false;
  }
  if (pid == null || !pidAlive(pid)) return false;
  const tty = await getTtyForPid(pid);
  if (!tty) return false;
  return focusExistingTerminalTab(tty);
}
