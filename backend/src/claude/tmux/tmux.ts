// Thin wrapper over the tmux CLI — every csm-managed tmux interaction goes through here so
// grids.ts (and its tests) never shell out directly. A missing session/pane is a normal race
// (the user closed it, the process exited), not a bug, so nothing here throws on that — callers
// get false/null/[] and decide what to do.
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { TMUX_BIN, LOGIN_SHELL, TMUX_SOCKET_NAME, TMUX_CONFIG_PATH } from "../../constants.ts";

// Dedicated socket + config isolate these server-wide settings from the user's own tmux/~/.tmux.conf — see docs/spec/2026-07-21-tmux-terminal-architecture.md §8.2/§10.1.
const CSM_TMUX_CONFIG = `
set -g status off
set -g mouse off
set -g set-titles on
set -g set-titles-string "#{session_name} #{pane_title}"
set -g pane-border-format "#{pane_title}"
bind -n S-Left select-pane -L
bind -n S-Right select-pane -R
bind -n S-Up select-pane -U
bind -n S-Down select-pane -D
`;
try {
  writeFileSync(TMUX_CONFIG_PATH, CSM_TMUX_CONFIG);
} catch {
  // best-effort — a missing config file just means the session starts with tmux's own defaults
}
// `-f` is only read when tmux forks a brand-new server, so a config edit never reaches this app's
// already-running long-lived server on its own — `source-file` re-applies it live (a no-op cost if
// no server exists yet, since starting one just preloads the same config anyway).
try {
  spawnSync(TMUX_BIN, ["-L", TMUX_SOCKET_NAME, "source-file", TMUX_CONFIG_PATH]);
} catch {
  // best-effort — see above
}

function socketArgs(): string[] {
  return ["-L", TMUX_SOCKET_NAME, "-f", TMUX_CONFIG_PATH];
}

// Wraps a shell-quoted claude invocation for a pane's argv: `exec` so killing the pane always kills
// claude directly (no lingering shell in the process tree), `-lic` so login/.zprofile PATH setup
// (and shell functions/aliases some users wrap `claude` in) applies under launchd's minimal PATH.
export function paneArgv(claudeCommand: string): string[] {
  return [LOGIN_SHELL, "-lic", `exec ${claudeCommand}`];
}

export type PaneInfo = {
  session: string;
  paneId: string; // stable `#{pane_id}` like "%3" — never a positional index, those get reused
  sid: string | null; // the claude session id tagged via `@csm_sid`, or null if untagged (not ours)
  pid: number | null;
  attached: boolean; // whether any client is currently attached to this pane's session
};

// Without LANG/LC_ALL (launchd's minimal env has neither), tmux treats the client as non-UTF-8 and
// replaces literal tab bytes in -F output with "_", corrupting PANE_FORMAT's tab-delimited parsing.
const TMUX_ENV = { ...process.env, LANG: "en_US.UTF-8", LC_ALL: "en_US.UTF-8" };

function run(args: string[]): { ok: boolean; stdout: string } {
  const res = spawnSync(TMUX_BIN, [...socketArgs(), ...args], { encoding: "utf8", env: TMUX_ENV });
  return { ok: res.status === 0, stdout: res.stdout ?? "" };
}

export function hasSession(session: string): boolean {
  return run(["has-session", "-t", session]).ok;
}

// Cached — TMUX_BIN is resolved once at startup and can't become installed/uninstalled mid-process,
// so there's no reason to re-spawn tmux on every /api/sessions poll just to check this.
let tmuxAvailableCache: boolean | null = null;
export function isTmuxAvailable(): boolean {
  if (tmuxAvailableCache == null) tmuxAvailableCache = run(["-V"]).ok;
  return tmuxAvailableCache;
}

// -P -F prints the new pane's #{pane_id} on success, so callers can tag it without a racy re-list.
export function newSession(session: string, argv: string[], cwd?: string): string | null {
  const args = ["new-session", "-d", "-P", "-F", "#{pane_id}", "-s", session];
  if (cwd) args.push("-c", cwd);
  const res = run([...args, "--", ...argv]);
  return res.ok ? res.stdout.trim() || null : null;
}

export function splitWindow(session: string, argv: string[], cwd?: string): string | null {
  const args = ["split-window", "-t", session, "-P", "-F", "#{pane_id}"];
  if (cwd) args.push("-c", cwd);
  const res = run([...args, "--", ...argv]);
  return res.ok ? res.stdout.trim() || null : null;
}

export function killPane(paneId: string): boolean {
  return run(["kill-pane", "-t", paneId]).ok;
}

// Moves one existing pane into its own brand-new session, leaving any sibling panes behind —
// `move-pane`'s target session must already exist (unlike `break-pane`, it won't vivify one from a
// bare name), so a throwaway placeholder session is created first and its lone pane killed once the
// real pane has landed. @csm_sid and other pane options survive the move untouched.
export function isolatePane(paneId: string, newSession: string): boolean {
  const placeholder = run(["new-session", "-d", "-P", "-F", "#{pane_id}", "-s", newSession]);
  if (!placeholder.ok) return false;
  const moved = run(["move-pane", "-d", "-s", paneId, "-t", newSession]);
  if (!moved.ok) {
    run(["kill-session", "-t", newSession]);
    return false;
  }
  const placeholderPaneId = placeholder.stdout.trim();
  if (placeholderPaneId) run(["kill-pane", "-t", placeholderPaneId]);
  return true;
}

export function killSession(session: string): boolean {
  return run(["kill-session", "-t", session]).ok;
}

// Literal text then a separate Enter — `-l` stops tmux from interpreting the prompt as key names,
// and a trailing newline embedded in the text would otherwise submit before the rest is sent.
export function sendKeys(paneId: string, text: string): boolean {
  const a = run(["send-keys", "-t", paneId, "-l", "--", text]);
  const b = run(["send-keys", "-t", paneId, "Enter"]);
  return a.ok && b.ok;
}

export function selectLayout(session: string, layout: string): boolean {
  return run(["select-layout", "-t", session, layout]).ok;
}

export function selectPane(paneId: string): boolean {
  return run(["select-pane", "-t", paneId]).ok;
}

export function setPaneOption(paneId: string, key: string, value: string): boolean {
  return run(["set-option", "-p", "-t", paneId, key, value]).ok;
}

// Redundant with the global config's `set -g status off` — kept as an explicit per-session
// reinforcement in case a session is ever created before the config file is in place.
export function setSessionStatusOff(session: string): void {
  run(["set-option", "-t", session, "status", "off"]);
}

export function renameSession(oldName: string, newName: string): boolean {
  return run(["rename-session", "-t", oldName, newName]).ok;
}

// Drives the terminal's title bar live (set-titles-string references #{pane_title} — see config
// above) and, when pane-border-status is on, that pane's own border label in a multi-pane grid.
export function setPaneTitle(paneId: string, title: string): boolean {
  return run(["select-pane", "-t", paneId, "-T", title]).ok;
}

// Per-pane title labels only make sense once a grid has more than one pane.
export function setPaneBorderStatus(session: string, on: boolean): boolean {
  return run(["set-option", "-t", session, "pane-border-status", on ? "top" : "off"]).ok;
}

const PANE_FORMAT = "#{session_name}\t#{pane_id}\t#{@csm_sid}\t#{pane_pid}";

export function listClients(): Set<string> {
  const res = run(["list-clients", "-F", "#{client_session}"]);
  if (!res.ok) return new Set();
  return new Set(res.stdout.split("\n").filter(Boolean));
}

// Only ever returns panes in the csm-grid-* namespace (edge case: a pre-existing manual tmux
// session of the user's must never be touched by reconciliation).
export function listPanesAll(): PaneInfo[] {
  const res = run(["list-panes", "-a", "-F", PANE_FORMAT]);
  if (!res.ok) return [];
  const attached = listClients();
  return res.stdout
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [session, paneId, sidRaw, pidRaw] = line.split("\t");
      return {
        session,
        paneId,
        sid: sidRaw && sidRaw !== "" ? sidRaw : null,
        pid: pidRaw ? Number(pidRaw) : null,
        attached: attached.has(session),
      };
    })
    .filter((p) => p.session.startsWith("csm-grid-"));
}

export type TmuxRunner = {
  hasSession: typeof hasSession;
  newSession: typeof newSession;
  splitWindow: typeof splitWindow;
  killPane: typeof killPane;
  isolatePane: typeof isolatePane;
  killSession: typeof killSession;
  sendKeys: typeof sendKeys;
  selectLayout: typeof selectLayout;
  selectPane: typeof selectPane;
  setPaneOption: typeof setPaneOption;
  setSessionStatusOff: typeof setSessionStatusOff;
  setPaneTitle: typeof setPaneTitle;
  setPaneBorderStatus: typeof setPaneBorderStatus;
  renameSession: typeof renameSession;
  listClients: typeof listClients;
  listPanesAll: typeof listPanesAll;
};

export const realTmux: TmuxRunner = {
  hasSession,
  newSession,
  splitWindow,
  killPane,
  isolatePane,
  killSession,
  sendKeys,
  selectLayout,
  selectPane,
  setPaneOption,
  setSessionStatusOff,
  setPaneTitle,
  setPaneBorderStatus,
  renameSession,
  listClients,
  listPanesAll,
};
