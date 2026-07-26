import { spawnSync } from "node:child_process";
import { json } from "./json.ts";
import { usingGhostty } from "../claude/terminal/ghosttyEnv.ts";

function hasAccessibilityAccess(): boolean {
  const result = spawnSync("osascript", ["-e", 'tell application "System Events" to UI elements enabled'], { encoding: "utf-8" });
  return result.stdout.trim() === "true";
}

function hasGhosttyAutomationAccess(): boolean {
  const result = spawnSync("osascript", ["-e", 'tell application "Ghostty" to count windows'], { encoding: "utf-8" });
  return result.status === 0;
}

// Reports THIS process's own Accessibility/Automation grants — macOS attributes a permission
// check to whichever app hosts the calling process, so only a check the daemon runs on itself
// (not setup.ts's own interactive invocation) reflects the daemon's true, separate grant.
export async function handlePermissionsRoutes(req: Request, url: URL): Promise<Response | null> {
  if (url.pathname === "/api/permissions" && req.method === "GET") {
    // null (not false) when Ghostty isn't installed — otherwise setup.ts prompts for a grant on
    // an app that doesn't exist and can never succeed (confirmed live on a Homebrew-less machine).
    return json({
      accessibility: hasAccessibilityAccess(),
      ghosttyAutomation: usingGhostty() ? hasGhosttyAutomationAccess() : null,
    });
  }
  return null;
}
