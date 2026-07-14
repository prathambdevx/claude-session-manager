// Shared constants, filesystem paths, and CLI flags for the whole server.
import { existsSync, readFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";

// src/ lives one level under the project root
const ROOT_DIR = join(import.meta.dir, "..");

export const HOME = homedir();
export const PROJECTS_DIR = join(HOME, ".claude", "projects");
export const RUNNING_DIR = join(HOME, ".claude", "sessions");
export const DATA_DIR = join(ROOT_DIR, "data");
export const META_PATH = join(DATA_DIR, "meta.json");
export const TICKETS_PATH = join(DATA_DIR, "tickets.json");
export const TODOS_PATH = join(DATA_DIR, "todos.json");
export const AGENTS_PATH = join(DATA_DIR, "agents.json");
export const BOARD_PATH = join(DATA_DIR, "board.json");
export const TODO_BOARD_PATH = join(DATA_DIR, "todo-board.json");
export const REVIEWS_DIR = join(DATA_DIR, "reviews");
export const CONTEXTS_DIR = join(DATA_DIR, "contexts");
export const DELEGATIONS_DIR = join(DATA_DIR, "delegations");
export const PUBLIC_DIR = join(ROOT_DIR, "public");
export const ROOT = ROOT_DIR;

await mkdir(REVIEWS_DIR, { recursive: true });
await mkdir(CONTEXTS_DIR, { recursive: true });
await mkdir(DELEGATIONS_DIR, { recursive: true });

// Optional local overrides in data/settings.json (gitignored, per-machine). Every field is
// optional; anything absent falls back to the safe defaults below. This is what makes a fresh
// clone work on any Mac without editing code — e.g. only machines with the extended 1M-context
// models set "extendedContext": true.
type Settings = {
  port?: number;
  claudeBin?: string;
  extendedContext?: boolean; // append [1m] to sonnet/opus model aliases
  effort?: string; // low | medium | high | xhigh | max
};
let settings: Settings = {};
try {
  settings = JSON.parse(readFileSync(join(DATA_DIR, "settings.json"), "utf-8"));
} catch {
  // no settings file — use defaults
}

export const PORT = settings.port ?? 4321;

// launchd runs this with a minimal PATH that doesn't include the real claude binary
export const CLAUDE_BIN =
  settings.claudeBin ||
  (existsSync(join(HOME, ".local/bin/claude")) ? join(HOME, ".local/bin/claude") : "claude");

export const KNOWN_MODELS = new Set(["sonnet", "opus", "haiku", "fable"]);
export const LAUNCH_MODES = new Set(["solo", "implement-review", "research"]);

// every session this tool launches skips permission prompts, at the user's explicit request
export const DANGEROUS_FLAG = " --dangerously-skip-permissions";
export const EFFORT_FLAG = ` --effort ${settings.effort ?? "medium"}`;

// Off by default so a fresh clone works on standard-context accounts. Machines entitled to the
// 1M-context Sonnet/Opus variants opt in via data/settings.json → "extendedContext": true.
export const EXTENDED_CONTEXT = settings.extendedContext ?? false;

// Context-window denominator for the % gauge — matches whichever window the launches actually use.
export const CONTEXT_WINDOW_TOKENS = EXTENDED_CONTEXT ? 1_000_000 : 200_000;
