// Fixed internal paths and constants — nothing here is user-configurable; config.ts holds the
// things that actually are.
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";

// src/ lives one level under backend/, which lives one level under the repo root. data/ and
// frontend/ are siblings of backend/, not backend/, so both need the extra ".." to reach them.
const BACKEND_DIR = join(import.meta.dir, "..");
const REPO_ROOT = join(BACKEND_DIR, "..");

export const HOME = homedir();
export const PROJECTS_DIR = join(HOME, ".claude", "projects");
export const RUNNING_DIR = join(HOME, ".claude", "sessions");
// CSM_DATA_DIR lets tests (tests/) point persistence at a throwaway temp dir instead of this
// machine's real data/ — never set this yourself when running the app normally.
export const DATA_DIR = process.env.CSM_DATA_DIR || join(REPO_ROOT, "data");
export const META_PATH = join(DATA_DIR, "meta.json");
export const TICKETS_PATH = join(DATA_DIR, "tickets.json");
export const TODOS_PATH = join(DATA_DIR, "todos.json");
export const AGENTS_PATH = join(DATA_DIR, "agents.json");
export const TODO_BOARD_PATH = join(DATA_DIR, "todo-board.json");
export const GROUP_BOARD_PATH = join(DATA_DIR, "group-board.json");
export const SAVED_VIEWS_PATH = join(DATA_DIR, "saved-views.json");
export const PID_LINKS_PATH = join(DATA_DIR, "pid-links.json");
export const CONTEXTS_DIR = join(DATA_DIR, "contexts");
export const DELEGATIONS_DIR = join(DATA_DIR, "delegations");
export const QUICKPROMPTS_DIR = join(DATA_DIR, "quickprompts");
// Detected terminal app (TERM_PROGRAM captured at `bun run setup` time) — see claude/tmux/terminalLauncher.ts.
export const TERMINAL_CONFIG_PATH = join(DATA_DIR, "terminal.json");
// Cache of the grid/pane map rebuilt from `tmux list-panes -a`/`list-clients` on every startup —
// tmux itself is canonical (see claude/tmux/grids.ts); this is just a warm-start convenience.
export const TMUX_STATE_PATH = join(DATA_DIR, "tmux-state.json");

// csm runs its own tmux server on a dedicated socket so the server-wide settings below (status off,
// mouse off, root-table Shift+Arrow bindings) never leak into a tmux server the user runs personally.
export const TMUX_SOCKET_NAME = "csm";
export const TMUX_CONFIG_PATH = join(DATA_DIR, "tmux.conf");
export const PUBLIC_DIR = join(REPO_ROOT, "frontend", "public");
// Component JS modules (frontend/src/**) are a sibling of public/, not nested under it — served
// separately since index.html's <script type="module"> requests them at /src/*.
export const FRONTEND_SRC_DIR = join(REPO_ROOT, "frontend", "src");
export const ROOT = REPO_ROOT;

await mkdir(CONTEXTS_DIR, { recursive: true });
await mkdir(DELEGATIONS_DIR, { recursive: true });
await mkdir(QUICKPROMPTS_DIR, { recursive: true });

export const KNOWN_MODELS = new Set(["sonnet", "opus", "haiku", "fable"]);

// every session this tool launches skips permission prompts, at the user's explicit request
export const DANGEROUS_FLAG = " --dangerously-skip-permissions";

// How long a Quick Prompt job delivered into an already-open terminal (no subprocess to await —
// see routes/quickPrompts.ts) waits for that session's transcript file to gain a new response
// before giving up. Shared with store.ts's reconcile check so a job left "running" past this
// window (e.g. the server restarted mid-wait, losing the in-memory watch loop) gets flagged stale.
export const QUICKPROMPT_TERMINAL_WATCH_TIMEOUT_MS = 6 * 60 * 1000;

export const PORT = 4321;

// Shared with setup.ts (which installs the launchd agent under this label) and
// polling/autoUpdater.ts (which restarts it via `launchctl kickstart` after a git pull).
export const LAUNCHD_LABEL = "com.claude-session-manager";

// Endpoint for the install/auto-update usage log. bootstrap.sh pings the same URL on first
// install — keep both in sync by hand, they can't share this constant since one's bash and one's
// TypeScript.
export const INSTALL_LOG_URL = "https://script.google.com/macros/s/AKfycbx0CyTns0VGytsm_0vfQgBu6VO1czZ88b5Z9_rI0R368b72TcQTWsxDW7LWLa3-ZAJAXQ/exec";

// A bin's location is entirely per-machine, and neither launchd's minimal PATH nor the non-login
// shell we launch terminal sessions under can see it — so resolve it at runtime for THIS device by
// asking the user's own login+interactive shell where its binary is (`whence -p`/`type -P` skip a
// shell-function wrapper some users alias). Standard install dirs and a bare command are only
// fallbacks if that probe can't answer. The env override always wins.
function resolveBin(name: string, envVar: string, knownDirs: string[]): string {
  if (process.env[envVar]) return process.env[envVar]!;
  try {
    const shell = process.env.SHELL || "/bin/zsh";
    const res = spawnSync(shell, ["-lic", `whence -p ${name} 2>/dev/null || type -P ${name} 2>/dev/null || command -v ${name} 2>/dev/null`], { encoding: "utf8", timeout: 5000 });
    const hit = (res.stdout || "").split("\n").map((s) => s.trim()).filter((l) => l.startsWith("/") && l.endsWith(`/${name}`) && existsSync(l)).pop();
    if (hit) return hit;
  } catch {
    // fall through to the location guesses below
  }
  for (const p of knownDirs) {
    if (existsSync(p)) return p;
  }
  return name;
}
export const CLAUDE_BIN = resolveBin("claude", "CSM_CLAUDE_BIN", [join(HOME, ".local/bin/claude"), "/opt/homebrew/bin/claude", "/usr/local/bin/claude"]);
export const TMUX_BIN = resolveBin("tmux", "CSM_TMUX_BIN", ["/opt/homebrew/bin/tmux", "/usr/local/bin/tmux", "/usr/bin/tmux"]);
// Panes run claude via `$LOGIN_SHELL -lic 'exec "<CLAUDE_BIN>" ...'` so login/.zprofile PATH setup
// applies and the shell disappears from the process tree once claude exits (see tmux/tmux.ts).
export const LOGIN_SHELL = process.env.SHELL || "/bin/zsh";
