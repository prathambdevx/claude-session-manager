// `bun run config` — pushes this app's own defaultModel/effort/extendedContext (data/settings.json,
// see src/config.ts) into your REAL Claude Code settings (~/.claude/settings.json), so they apply
// everywhere you run `claude`, not just from this app. Read-merge-write: only ever touches the
// "model" and "effortLevel" keys (confirmed via code.claude.com/docs/en/model-config), leaving
// everything else in that file — permissions, hooks, plugins, theme — completely untouched.
import { readFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { HOME } from "./src/constants.ts";
import { DEFAULT_MODEL, DEFAULT_EFFORT, EXTENDED_CONTEXT } from "./src/config.ts";
import { modelAliasWithContext } from "./src/claude/prompts.ts";

const SETTINGS_PATH = join(HOME, ".claude", "settings.json");

function loadRealSettings(): Record<string, unknown> {
  try {
    return JSON.parse(readFileSync(SETTINGS_PATH, "utf-8"));
  } catch {
    return {};
  }
}

const current = loadRealSettings();
const newModel = modelAliasWithContext(DEFAULT_MODEL);

console.log("Syncing this app's config into your real Claude Code settings:");
console.log(`  ${SETTINGS_PATH}`);
console.log("");
console.log(`  model:        ${JSON.stringify(current.model ?? null)} -> ${JSON.stringify(newModel)}`);
console.log(`  effortLevel:  ${JSON.stringify(current.effortLevel ?? null)} -> ${JSON.stringify(DEFAULT_EFFORT)}`);
if (!EXTENDED_CONTEXT && (DEFAULT_MODEL === "sonnet" || DEFAULT_MODEL === "opus")) {
  console.log("");
  console.log("  (extendedContext is off in data/settings.json — writing the plain alias, no [1m])");
}

const updated = { ...current, model: newModel, effortLevel: DEFAULT_EFFORT };

await mkdir(join(HOME, ".claude"), { recursive: true });
await Bun.write(SETTINGS_PATH, JSON.stringify(updated, null, 2) + "\n");

console.log("");
console.log("✓ Done — every other key in that file (permissions, hooks, plugins, theme, ...) was left as-is.");
