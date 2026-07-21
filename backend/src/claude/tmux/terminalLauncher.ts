// Resolves which terminal app to use and knows how to open/focus one attached to a grid's tmux
// session. See docs/spec/2026-07-21-tmux-terminal-architecture.md §8 for the full decision table —
// this is the implementation of it.
import { existsSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { TERMINAL_CONFIG_PATH, TMUX_BIN, TMUX_SOCKET_NAME, TMUX_CONFIG_PATH } from "../../constants.ts";

// Repeats tmux.ts's -L/-f socket flags — a separate process, so it'd attach to the wrong server without them.
const ATTACH_ARGS = ["-L", TMUX_SOCKET_NAME, "-f", TMUX_CONFIG_PATH, "attach", "-t"];

export const KNOWN_TERMINALS = ["Ghostty", "iTerm", "WezTerm", "kitty", "Alacritty", "Warp", "Terminal"] as const;
export type TerminalApp = (typeof KNOWN_TERMINALS)[number];

export function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

// TERM_PROGRAM/TERM values as seen at setup time — captured once in setup.ts, read back here.
function fromEnvValues(termProgram: string | undefined, term: string | undefined): TerminalApp | null {
  if (termProgram === "ghostty") return "Ghostty";
  if (termProgram === "iTerm.app") return "iTerm";
  if (termProgram === "WarpTerminal") return "Warp";
  if (termProgram === "WezTerm") return "WezTerm";
  if (termProgram === "Apple_Terminal") return "Terminal";
  if (term === "xterm-ghostty") return "Ghostty";
  if (term === "xterm-kitty") return "kitty";
  if (term === "alacritty") return "Alacritty";
  return null;
}

/** Reads TERM_PROGRAM/TERM from the current environment — called once by setup.ts to persist a choice. */
export function detectTerminalFromEnv(): TerminalApp | null {
  return fromEnvValues(process.env.TERM_PROGRAM, process.env.TERM);
}

export function saveTerminalConfig(app: TerminalApp): void {
  writeFileSync(TERMINAL_CONFIG_PATH, JSON.stringify({ app }, null, 2));
}

function loadSavedTerminal(): TerminalApp | null {
  try {
    const raw = JSON.parse(readFileSync(TERMINAL_CONFIG_PATH, "utf8"));
    return KNOWN_TERMINALS.includes(raw.app) ? raw.app : null;
  } catch {
    return null;
  }
}

const APP_BUNDLE_PATHS: Partial<Record<TerminalApp, string>> = {
  Ghostty: "/Applications/Ghostty.app",
  iTerm: "/Applications/iTerm.app",
  WezTerm: "/Applications/WezTerm.app",
  kitty: "/Applications/kitty.app",
  Alacritty: "/Applications/Alacritty.app",
};

// Resolution chain (§8.1): explicit override, then the value captured at setup, then a live
// /Applications scan, then Apple Terminal — which always exists, so this never returns null.
export function resolveTerminalApp(): TerminalApp {
  const override = process.env.CSM_TERMINAL;
  if (override && (KNOWN_TERMINALS as readonly string[]).includes(override)) return override as TerminalApp;

  const saved = loadSavedTerminal();
  if (saved) return saved;

  for (const [app, bundle] of Object.entries(APP_BUNDLE_PATHS)) {
    if (bundle && existsSync(bundle)) return app as TerminalApp;
  }
  return "Terminal";
}

function writeAttachCommandFile(session: string): string {
  const path = join(tmpdir(), `csm-attach-${randomUUID()}.command`);
  const attachCmd = [TMUX_BIN, ...ATTACH_ARGS, session].map(shellQuote).join(" ");
  writeFileSync(path, `#!/bin/bash\nexec ${attachCmd}\n`);
  chmodSync(path, 0o755);
  return path;
}

function spawnDetached(cmd: string, args: string[]): void {
  const child = spawn(cmd, args, { detached: true, stdio: "ignore" });
  child.unref();
}

// Every recipe ends up running `tmux attach -t <session>` inside the resolved app — see spec §8.2
// for why Ghostty must be launched via its own binary's `-e`, never `open -na` (docs/ghostty-
// instance-bug-explainer.md documents the instance-duplication bug that caused).
export function openTerminalForGrid(session: string, app: TerminalApp = resolveTerminalApp()): void {
  switch (app) {
    case "Ghostty":
      spawnDetached(`${APP_BUNDLE_PATHS.Ghostty}/Contents/MacOS/ghostty`, ["-e", TMUX_BIN, ...ATTACH_ARGS, session]);
      return;
    case "kitty":
      spawnDetached(`${APP_BUNDLE_PATHS.kitty}/Contents/MacOS/kitty`, [TMUX_BIN, ...ATTACH_ARGS, session]);
      return;
    case "Alacritty":
      spawnDetached(`${APP_BUNDLE_PATHS.Alacritty}/Contents/MacOS/alacritty`, ["-e", TMUX_BIN, ...ATTACH_ARGS, session]);
      return;
    case "WezTerm":
      spawnDetached(`${APP_BUNDLE_PATHS.WezTerm}/Contents/MacOS/wezterm`, ["start", "--", TMUX_BIN, ...ATTACH_ARGS, session]);
      return;
    case "iTerm":
      spawnDetached("open", ["-a", "iTerm", writeAttachCommandFile(session)]);
      return;
    // Warp's command-on-launch support is too limited to drive reliably — fall back to Apple
    // Terminal; the grid itself is unaffected, the user can always `tmux attach` by hand too.
    case "Warp":
    case "Terminal":
    default:
      spawnDetached("open", ["-a", "Terminal", writeAttachCommandFile(session)]);
      return;
  }
}

// App activation only — doesn't target a specific OS window among 2+ open ones of the same app.
// The fallback path for focusGridWindow below, used when AX raising isn't available or misses.
export function focusTerminalApp(app: TerminalApp = resolveTerminalApp()): void {
  const openName = app === "Warp" ? "Terminal" : app;
  spawnDetached("open", ["-a", openName]);
}

function osascript(script: string): Promise<string> {
  return new Promise((resolve) => {
    const child = spawn("osascript", ["-e", script], { stdio: ["ignore", "pipe", "ignore"] });
    let out = "";
    child.stdout.on("data", (d) => (out += d.toString()));
    child.on("close", () => resolve(out.trim()));
    child.on("error", () => resolve(""));
  });
}

// System Events' process name for each app's OS window list — differs from the app's own display
// name for a couple of these (iTerm2's process is "iTerm2", WezTerm's GUI binary is "wezterm-gui").
// Warp isn't included: its windows aren't Warp's own (see focusTerminalApp), they're Terminal's.
const AX_PROCESS_NAME: Partial<Record<TerminalApp, string>> = {
  Terminal: "Terminal", iTerm: "iTerm2", WezTerm: "wezterm-gui", kitty: "kitty", Alacritty: "Alacritty",
  Ghostty: "ghostty",
};

// Ghostty runs one OS process per window (not one shared instance with tabs), so addressing "the"
// process by name is ambiguous — iterate every process with this name instead of assuming there's
// only one, and raise whichever one actually owns the matching window.
function raiseWindowByTitle(processName: string, session: string): Promise<boolean> {
  const script = `
    tell application "System Events"
      repeat with p in (every process whose name is "${processName}")
        repeat with w in windows of p
          if (name of w) contains "${session}" then
            set frontmost of p to true
            perform action "AXRaise" of w
            return "true"
          end if
        end repeat
      end repeat
    end tell
    return "false"
  `;
  return osascript(script).then((out) => out === "true");
}

// Precise version of focusTerminalApp: raises the specific OS window already attached to `session`
// among 2+ open ones, matched by the grid name tmux embeds in the title — works for every known
// terminal (§7.2's "needs AX automation" gap, now filled), not just a hardcoded subset.
export function focusGridWindow(session: string, app: TerminalApp = resolveTerminalApp()): void {
  const processName = AX_PROCESS_NAME[app === "Warp" ? "Terminal" : app];
  if (processName) {
    raiseWindowByTitle(processName, session).then((found) => { if (!found) focusTerminalApp(app); });
    return;
  }
  focusTerminalApp(app);
}
