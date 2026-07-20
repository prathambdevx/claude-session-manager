// Closing a Ghostty window through the dashboard's own "Close terminal" action also explicitly
// kills the process — necessary because closing a window alone doesn't reliably terminate what's
// running inside it (see closeRunningSessionTerminal). Closing a window directly in Ghostty skips
// that second step entirely, so the process can survive as an orphan with no window attached,
// leaving the dot green forever. This periodically checks for exactly that and cleans it up.
import { spawn } from "node:child_process";
import { loadRunning } from "../store.ts";
import { usingGhostty } from "../claude/terminal/ghosttyEnv.ts";
import { ghosttyWindowTag } from "../claude/terminal/terminalLaunch.ts";
import { broadcast } from "../sse.ts";

function liveGhosttyTags(): Promise<Set<string>> {
  return new Promise((resolve) => {
    const child = spawn("osascript", ["-e", `
tell application "Ghostty"
  set out to ""
  repeat with w in windows
    repeat with t in tabs of w
      set out to out & (name of t) & linefeed
    end repeat
  end repeat
  return out
end tell
    `], { stdio: ["ignore", "pipe", "ignore"] });
    let out = "";
    child.stdout.on("data", (d) => (out += d.toString()));
    child.on("close", () => {
      const tags = new Set<string>();
      for (const m of out.matchAll(/csm-[0-9a-f]{8}/g)) tags.add(m[0]);
      resolve(tags);
    });
    child.on("error", () => resolve(new Set()));
  });
}

async function sweepOrphans() {
  if (!usingGhostty()) return; // Terminal.app has no equivalent tag-based window list
  const running = await loadRunning(); // already filtered to only pid-alive entries
  const sessionIds = Object.keys(running);
  if (!sessionIds.length) return;
  const openTags = await liveGhosttyTags();
  for (const sessionId of sessionIds) {
    if (openTags.has(ghosttyWindowTag(sessionId))) continue;
    try {
      process.kill(running[sessionId].pid);
    } catch {
      // already gone
    }
    // Don't wait on Claude Code's own status file happening to get cleaned up and fsWatcher.ts
    // noticing that separately — grey out the dot from this sweep directly.
    broadcast({ type: "session-patch", id: sessionId, patch: { running: null } });
  }
}

let started = false;
export function startOrphanWatcher(intervalMs = 4000): void {
  if (started) return; // idempotent — tests may import routes more than once
  started = true;
  setInterval(() => {
    sweepOrphans().catch(() => {}); // best-effort; a transient failure just waits for the next tick
  }, intervalMs);
}
