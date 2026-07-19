// Shared "is Ghostty installed" check — used by launching, focus, and injection logic alike.
import { existsSync } from "node:fs";

export const GHOSTTY_APP = "/Applications/Ghostty.app";

// AppleScript "tell application Terminal" requires TCC Automation permission for the calling
// process — fine when this server runs interactively, but silently denied (no error, no window)
// when running as a launchd background job with no way to prompt for that permission. Opening a
// .command file via `open` instead just uses Launch Services (same as double-clicking one in
// Finder), which doesn't need Automation access at all.
export function usingGhostty(): boolean {
  return existsSync(GHOSTTY_APP);
}
