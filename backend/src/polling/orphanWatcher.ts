// Closing a Ghostty window through the dashboard's own "Close terminal" action also explicitly
// kills the process — necessary because closing a window alone doesn't reliably terminate what's
// running inside it (see closeRunningSessionTerminal). Closing a window directly in Ghostty skips
// that second step entirely, so the process can survive as an orphan with no window attached,
// leaving the dot green forever. This periodically checks for exactly that and cleans it up.
import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { loadRunning, loadAllQuickPromptJobs, loadAllDelegations, waitForPidExit } from "../store.ts";
import { usingGhostty } from "../claude/terminal/ghosttyEnv.ts";
import { ghosttyWindowTag, ghosttyTitleFilePath } from "../claude/terminal/terminalLaunch.ts";
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
  const [openTags, quickPrompts, delegations] = await Promise.all([
    liveGhosttyTags(),
    loadAllQuickPromptJobs(),
    loadAllDelegations(),
  ]);
  // A running headless job (Quick Prompt or Delegation) never had a Ghostty window to begin with —
  // matched by sessionId, not pid, since a pty-wrapped job's saved pid is `script`'s, not claude's.
  const headlessSessionIds = new Set<string>();
  for (const j of quickPrompts) if (j.status === "running") headlessSessionIds.add(j.sessionId);
  for (const d of delegations) if (d.status === "running") headlessSessionIds.add(d.sessionId);
  await Promise.all(sessionIds.map(async (sessionId) => {
    // Only sweep sessions THIS app launched: every launch writes a Ghostty title file and nothing
    // else does, so its absence marks a claude session the user started on their own — never ours to kill.
    if (!existsSync(ghosttyTitleFilePath(sessionId))) return;
    if (openTags.has(ghosttyWindowTag(sessionId))) return;
    if (headlessSessionIds.has(sessionId)) return;
    const pid = running[sessionId].pid;
    try {
      process.kill(pid);
    } catch {
      // already gone
    }
    await waitForPidExit(pid); // confirm it's actually gone before greying out the dot
    broadcast({ type: "session-patch", id: sessionId, patch: { running: null } });
  }));
}

let started = false;
export function startOrphanWatcher(intervalMs = 4000): void {
  if (started) return; // idempotent — tests may import routes more than once
  started = true;
  setInterval(() => {
    sweepOrphans().catch(() => {}); // best-effort; a transient failure just waits for the next tick
  }, intervalMs);
}
