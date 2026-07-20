// Fixed internal paths and constants — nothing here is user-configurable; config.ts holds the
// things that actually are.
import { existsSync } from "node:fs";
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
// One small text file per resumed session, read by a polling loop inside its Ghostty window (see
// ghosttyTitleFilePath in claude.ts) so a rename in the UI can update an already-open window's
// title live — Ghostty's window "name" is read-only via AppleScript, so this file is the only way
// to push a title change into a window that's already running.
export const GHOSTTY_TITLES_DIR = join(DATA_DIR, "ghostty-titles");
// Ordered list of currently-open csm-<id8> tags, oldest first — lets auto-tiling assign quadrants
// by real open order instead of trusting System Events' window list order, which is only reliable
// for the just-created window (always frontmost); order among the rest isn't dependable.
export const GHOSTTY_WINDOW_ORDER_PATH = join(DATA_DIR, "ghostty-window-order.json");
export const PUBLIC_DIR = join(REPO_ROOT, "frontend", "public");
// Component JS modules (frontend/src/**) are a sibling of public/, not nested under it — served
// separately since index.html's <script type="module"> requests them at /src/*.
export const FRONTEND_SRC_DIR = join(REPO_ROOT, "frontend", "src");
export const ROOT = REPO_ROOT;

await mkdir(CONTEXTS_DIR, { recursive: true });
await mkdir(DELEGATIONS_DIR, { recursive: true });
await mkdir(QUICKPROMPTS_DIR, { recursive: true });
await mkdir(GHOSTTY_TITLES_DIR, { recursive: true });

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

// launchd runs this with a minimal PATH that doesn't include the real claude binary.
const LOCAL_CLAUDE_BIN = join(HOME, ".local/bin/claude");
export const CLAUDE_BIN = existsSync(LOCAL_CLAUDE_BIN) ? LOCAL_CLAUDE_BIN : "claude";
