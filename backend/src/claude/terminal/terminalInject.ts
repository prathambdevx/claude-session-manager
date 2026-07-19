// Quick Prompt's "terminal already open" path — types the prompt in as if the user did, no
// subprocess. Ghostty gets true no-focus delivery; Terminal.app falls back to focus-and-restore.
import { spawn } from "node:child_process";
import { pidAlive } from "../../store.ts";
import { usingGhostty } from "./ghosttyEnv.ts";
import { tryFocusRunningSession } from "./terminalFocus.ts";

function appleScriptQuote(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

// Types the whole prompt in as one keystroke (not simulated character-by-character — a single
// paste-like burst) into whatever window is currently frontmost, then presses Return to submit it.
// Requires the caller to have already focused the right window (see sendPromptToRunningTerminal)
// and requires this app to have Accessibility permission granted via System Events — macOS prompts
// for that the first time it's used.
function typeIntoFocusedWindow(text: string): Promise<boolean> {
  // a literal newline typed via `keystroke` would submit early (Return mid-prompt) — collapse to
  // one line, the terminal's own line-wrapping handles display
  const singleLine = text.replace(/\s*\n\s*/g, " ").trim();
  const script = `
    tell application "System Events"
      keystroke "${appleScriptQuote(singleLine)}"
      delay 0.2
      key code 36
    end tell
  `;
  return new Promise((resolve) => {
    const child = spawn("osascript", ["-e", script], { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr?.on("data", (d) => (stderr += d.toString()));
    child.on("close", (code) => {
      // most common cause: this app hasn't been granted Accessibility permission for System
      // Events yet (System Settings → Privacy & Security → Accessibility) — macOS refuses the
      // keystroke silently from the caller's perspective (just a non-zero exit + this stderr line)
      if (code !== 0) console.error("[quickPrompt] typeIntoFocusedWindow failed:", stderr.trim() || `osascript exited ${code}`);
      resolve(code === 0);
    });
    child.on("error", (e) => {
      console.error("[quickPrompt] typeIntoFocusedWindow failed to spawn osascript:", e.message);
      resolve(false);
    });
  });
}

// macOS only lets System Events type into whatever's currently frontmost — no OS-level way to send
// keystrokes to a window that isn't focused. This is the Terminal.app fallback path only (used
// when Ghostty isn't installed): capture whatever app has focus right now (almost certainly the
// browser, mid-click on "Send") and switch straight back to it once the prompt's been typed in.
// Ghostty itself has a real fix below — see sendTextToGhosttyTerminal.
function getFrontmostAppName(): Promise<string | null> {
  const script = `tell application "System Events" to get name of first application process whose frontmost is true`;
  return new Promise((resolve) => {
    const child = spawn("osascript", ["-e", script], { stdio: ["ignore", "pipe", "ignore"] });
    let out = "";
    child.stdout?.on("data", (d) => (out += d.toString()));
    child.on("close", () => resolve(out.trim() || null));
    child.on("error", () => resolve(null));
  });
}

function restoreFrontmostApp(name: string): Promise<void> {
  const script = `tell application "${appleScriptQuote(name)}" to activate`;
  return new Promise((resolve) => {
    const child = spawn("osascript", ["-e", script], { stdio: ["ignore", "ignore", "ignore"] });
    child.on("close", () => resolve());
    child.on("error", () => resolve());
  });
}

// Ghostty (1.3+) has its own AppleScript object model — `input text ... to t` / `send key ... to
// t` operate on a terminal reference directly and, per Ghostty's own docs, do NOT focus or bring
// that window forward (only the separate `focus` command does that). This is a genuine no-focus
// delivery path, not a workaround — replaces the System Events keystroke simulation entirely for
// anyone running Ghostty (this app's primary supported terminal).
function sendTextToGhosttyTerminal(tag: string, text: string): Promise<boolean> {
  // a literal newline would submit early if paste-mode doesn't buffer it as expected — collapse to
  // one line, then send a single explicit Return, same safety margin as the keystroke path below
  const singleLine = text.replace(/\s*\n\s*/g, " ").trim();
  const script = `
    tell application "Ghostty"
      set matches to every terminal whose name contains "${appleScriptQuote(tag)}"
      if (count of matches) = 0 then return "false"
      set t to item 1 of matches
      input text "${appleScriptQuote(singleLine)}" to t
      delay 0.2
      send key "enter" to t
      return "true"
    end tell
  `;
  return new Promise((resolve) => {
    const child = spawn("osascript", ["-e", script], { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let stderr = "";
    child.stdout?.on("data", (d) => (out += d.toString()));
    child.stderr?.on("data", (d) => (stderr += d.toString()));
    child.on("close", (code) => {
      const ok = code === 0 && out.trim() === "true";
      if (!ok) console.error("[quickPrompt] sendTextToGhosttyTerminal failed:", stderr.trim() || out.trim() || `osascript exited ${code}`);
      resolve(ok);
    });
    child.on("error", (e) => {
      console.error("[quickPrompt] sendTextToGhosttyTerminal failed to spawn osascript:", e.message);
      resolve(false);
    });
  });
}

// Delivers into the session's existing terminal; returns false if none is open or delivery
// failed, so the caller can fall back to a headless run (see routes/quickPrompts.ts).
export async function sendPromptToRunningTerminal(pid: number | null, ghosttyTag: string | undefined, prompt: string): Promise<boolean> {
  // The csm-<id> tag's presence IS "this session's terminal is open" — no pid needed. A live pid
  // was previously required and wrongly vetoed delivery when loadRunning()'s status files lagged.
  if (usingGhostty()) {
    return ghosttyTag ? sendTextToGhosttyTerminal(ghosttyTag, prompt) : false;
  }
  // Terminal.app has no per-window scripting object, so it matches by tty — which needs a live pid.
  if (pid == null || !pidAlive(pid)) return false;
  const previousApp = await getFrontmostAppName();
  const focused = await tryFocusRunningSession(pid, ghosttyTag);
  if (!focused) return false;
  await new Promise((r) => setTimeout(r, 250)); // give the window a beat to actually receive focus
  const delivered = await typeIntoFocusedWindow(prompt);
  if (previousApp) await restoreFrontmostApp(previousApp);
  return delivered;
}
