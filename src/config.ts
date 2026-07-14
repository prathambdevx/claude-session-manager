// Shared constants, filesystem paths, and CLI flags for the whole server.
import { existsSync } from "node:fs";
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
export const AGENTS_PATH = join(DATA_DIR, "agents.json");
export const REVIEWS_DIR = join(DATA_DIR, "reviews");
export const CONTEXTS_DIR = join(DATA_DIR, "contexts");
export const DELEGATIONS_DIR = join(DATA_DIR, "delegations");
export const PUBLIC_DIR = join(ROOT_DIR, "public");
export const PORT = 4321;

await mkdir(REVIEWS_DIR, { recursive: true });
await mkdir(CONTEXTS_DIR, { recursive: true });
await mkdir(DELEGATIONS_DIR, { recursive: true });

// launchd runs this with a minimal PATH that doesn't include the real claude binary
export const CLAUDE_BIN = existsSync(join(HOME, ".local/bin/claude"))
  ? join(HOME, ".local/bin/claude")
  : "claude";

export const KNOWN_MODELS = new Set(["sonnet", "opus", "haiku", "fable"]);
export const LAUNCH_MODES = new Set(["solo", "implement-review", "research"]);

// every session this tool launches skips permission prompts, at the user's explicit request
export const DANGEROUS_FLAG = " --dangerously-skip-permissions";
export const EFFORT_FLAG = " --effort medium";

// Context-window denominator for the % estimate. The transcript never records which window
// variant was active for a session, so this can't be detected per-session — this whole
// environment runs the 1M-context Sonnet variant (claude-sonnet-5[1m]) by default.
export const CONTEXT_WINDOW_TOKENS = 1_000_000;
