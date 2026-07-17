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
export const PID_LINKS_PATH = join(DATA_DIR, "pid-links.json");
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
export const EFFORT_FLAG = settings.effort ? ` --effort ${settings.effort}` : "";

// Whether to use the 1M-context [1m] model variants. Resolution order:
//   1. explicit data/settings.json → "extendedContext": true|false always wins (manual override)
//   2. otherwise AUTO-DETECT from the user's own Claude Code config: if their ~/.claude/settings.json
//      already references a "[1m]" model, they're entitled to and using it, so match that.
//   3. otherwise off (safe default — appending [1m] on a non-entitled account makes launches fail).
// This means a 1M-plan user who's set it up in Claude Code gets 1M sessions + a correct % gauge
// with zero configuration, while standard accounts stay safely on 200k.
function detectExtendedFromClaudeConfig(): boolean {
  for (const p of [join(HOME, ".claude", "settings.json"), join(HOME, ".claude.json")]) {
    try {
      if (readFileSync(p, "utf-8").includes("[1m]")) return true;
    } catch {
      // file missing / unreadable — ignore
    }
  }
  return false;
}
export const EXTENDED_CONTEXT = settings.extendedContext ?? detectExtendedFromClaudeConfig();

// Context-window denominator for the % gauge — matches whichever window the launches actually use.
export const CONTEXT_WINDOW_TOKENS = EXTENDED_CONTEXT ? 1_000_000 : 200_000;
