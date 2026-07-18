// Launching a new interactive `claude` session in a terminal window (Ghostty preferred, Apple
// Terminal fallback), plus the Ghostty window-title bookkeeping that keeps a renamed session's
// already-open window title in sync.
import { chmod, unlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { GHOSTTY_TITLES_DIR } from "../config.ts";
import { usingGhostty } from "./ghosttyEnv.ts";

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

// Escapes a string for embedding inside an AppleScript double-quoted literal.
function appleScriptQuote(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

export async function openTerminalRunning(cwd: string, command: string, opts: { ghosttyTitleFile?: string } = {}) {
  if (usingGhostty()) {
    // A background loop re-reads the title file every second and re-asserts it via OSC — this is
    // what lets a rename in the UI update an already-open window's title live. It's wrapped in a
    // subshell + EXIT trap so the loop is killed the moment the main command exits (verified live:
    // no orphaned loop process left behind once the terminal's job finishes).
    const wrapped = opts.ghosttyTitleFile
      ? `( while true; do printf '\\033]0;%s\\007' "$(cat ${shellQuote(opts.ghosttyTitleFile)} 2>/dev/null || echo 'Claude session')"; sleep 1; done & ); __csm_title_pid=$!; trap "kill $__csm_title_pid 2>/dev/null" EXIT; ${command}`
      : command;

    // Launch into the EXISTING Ghostty instance via its native AppleScript (Ghostty 1.3+), NOT
    // `open -na`. `open -na` forks a brand-new Ghostty *instance* on every launch (`-n` = new
    // instance) — confirmed live as ~1 instance per session — and AppleScript can only ever script
    // ONE instance, so a session opened in any other instance is invisible to
    // focusExistingGhosttyWindow, which is exactly why Resume kept spawning a duplicate terminal
    // instead of focusing the real one. `new window with configuration` opens inside the single
    // scriptable instance, so every session's window is enumerable (and thus focusable) afterward.
    //
    // The command goes through a temp script file rather than inline into the AppleScript string:
    // it sidesteps both AppleScript escaping of the (quote/backslash-heavy) title loop AND any
    // ambiguity in how Ghostty parses the `command` field — `zsh <path>` is unambiguous either way.
    const script = `#!/bin/zsh\ncd ${shellQuote(cwd)}\n${wrapped}\n`;
    const path = join(tmpdir(), `claude-sessions-launch-${crypto.randomUUID()}.sh`);
    await Bun.write(path, script);
    const osa = [
      'tell application "Ghostty"',
      "  set cfg to new surface configuration",
      `  set command of cfg to "zsh ${appleScriptQuote(path)}"`,
      "  set win to new window with configuration cfg",
      "  activate",
      "end tell",
    ].join("\n");
    spawn("osascript", ["-e", osa], { stdio: "ignore", detached: true }).unref();
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
