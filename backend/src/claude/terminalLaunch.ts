// Launching a new interactive `claude` session in a terminal window (Ghostty preferred, Apple
// Terminal fallback), plus the Ghostty window-title bookkeeping that keeps a renamed session's
// already-open window title in sync.
import { chmod, unlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { GHOSTTY_TITLES_DIR } from "../config.ts";
import { GHOSTTY_APP, usingGhostty } from "./ghosttyEnv.ts";

export function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

// Short marker (first 8 hex chars of the session id — effectively collision-free for a personal
// session count) embedded as a bracketed suffix in the window title, e.g. "Bugs v1 [a738]". This
// lets focusExistingGhosttyWindow substring-match the right window later without showing the full
// UUID in the title bar — see ghosttyWindowTitle for the human-facing title this is embedded in.
export function ghosttyWindowTag(sessionId: string): string {
  return `csm-${sessionId.slice(0, 8)}`;
}

// The human-facing title for a resumed session's Ghostty window: its display label (name /
// first-message, same as the UI shows) with the short match tag appended.
export function ghosttyWindowTitle(label: string, sessionId: string): string {
  const clean = (label || "Claude session").replace(/[\r\n]/g, " ").trim().slice(0, 60);
  return `${clean}  [${ghosttyWindowTag(sessionId)}]`;
}

// One small text file per session holding its current desired Ghostty title. Ghostty's window
// "name" is read-only via AppleScript (confirmed: attempting `set name of window` errors), so a
// rename in the UI can't be pushed into an already-open window directly. Instead, the window
// itself runs a background loop (see openTerminalRunning) that re-reads this file every second and
// re-asserts the title via an OSC escape — renaming a session just rewrites this file, and the
// open window picks it up within ~1s.
export function ghosttyTitleFilePath(sessionId: string): string {
  return join(GHOSTTY_TITLES_DIR, `${sessionId}.txt`);
}
export async function writeGhosttyTitle(sessionId: string, title: string): Promise<void> {
  await Bun.write(ghosttyTitleFilePath(sessionId), title);
}
export async function deleteGhosttyTitle(sessionId: string): Promise<void> {
  await unlink(ghosttyTitleFilePath(sessionId)).catch(() => {}); // fine if it was never created
}

export async function openTerminalRunning(cwd: string, command: string, opts: { ghosttyTitleFile?: string } = {}) {
  // Ghostty: pass the command as real CLI args (`ghostty -e zsh -c "<command>"`) instead of
  // writing + executing a .command script file. Executing a script file makes Ghostty show its
  // own "Allow Ghostty to execute ...command" confirmation dialog every single launch; running a
  // command via -e is a normal CLI invocation and never triggers that prompt. `open -na <app>
  // --args ...` is required (rather than `open -a`) to actually forward args on macOS — `open -na`
  // still just uses Launch Services, so still no Automation/permission prompt either.
  if (usingGhostty()) {
    // A background loop re-reads the title file every second and re-asserts it via OSC — this is
    // what lets a rename in the UI update an already-open window's title live. It's wrapped in a
    // subshell + EXIT trap so the loop is killed the moment the main command exits (verified live:
    // no orphaned loop process left behind once the terminal's job finishes).
    const wrapped = opts.ghosttyTitleFile
      ? `( while true; do printf '\\033]0;%s\\007' "$(cat ${shellQuote(opts.ghosttyTitleFile)} 2>/dev/null || echo 'Claude session')"; sleep 1; done & ); __csm_title_pid=$!; trap "kill $__csm_title_pid 2>/dev/null" EXIT; ${command}`
      : command;
    spawn(
      "open",
      ["-na", GHOSTTY_APP, "--args", `--working-directory=${cwd}`, "-e", "zsh", "-c", wrapped],
      { stdio: "ignore", detached: true }
    ).unref();
    return;
  }

  // Apple Terminal has no equivalent "-e" flag, so fall back to writing a .command file and
  // opening it via Launch Services (same as double-clicking one in Finder) — no permission
  // needed. (AppleScript "tell application Terminal" would need TCC Automation permission and is
  // silently denied when this server runs as a launchd background job with no way to prompt.)
  const script = `#!/bin/zsh\ncd ${shellQuote(cwd)}\n${command}\n`;
  const path = join(tmpdir(), `claude-sessions-launch-${crypto.randomUUID()}.command`);
  await Bun.write(path, script);
  await chmod(path, 0o755);
  spawn("open", ["-a", "Terminal", path], { stdio: "ignore", detached: true }).unref();
}
