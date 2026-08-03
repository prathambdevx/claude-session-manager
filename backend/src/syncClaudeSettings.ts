import { readFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { HOME } from "./constants.ts";
import { DEFAULT_MODEL, DEFAULT_EFFORT } from "./config.ts";
import { modelAliasWithContext } from "./claude/prompts.ts";

const SETTINGS_PATH = join(HOME, ".claude", "settings.json");

function loadRealSettings(): Record<string, unknown> {
  try {
    return JSON.parse(readFileSync(SETTINGS_PATH, "utf-8"));
  } catch {
    return {};
  }
}

export type SyncResult = { path: string; previousModel: unknown; newModel: string; previousEffort: unknown };

// Read-merge-write into ~/.claude/settings.json: only ever touches "model"/"effortLevel" (confirmed
// via code.claude.com/docs/en/model-config), leaving permissions/hooks/plugins/theme untouched — so
// every `claude` invocation (not just launches from this app) defaults to this app's configured
// model (see config.ts), e.g. the 1M-context Sonnet variant.
export async function syncClaudeSettings(): Promise<SyncResult> {
  const current = loadRealSettings();
  const newModel = modelAliasWithContext(DEFAULT_MODEL);
  const result: SyncResult = {
    path: SETTINGS_PATH,
    previousModel: current.model ?? null,
    newModel,
    previousEffort: current.effortLevel ?? null,
  };
  const updated = { ...current, model: newModel, effortLevel: DEFAULT_EFFORT };
  await mkdir(join(HOME, ".claude"), { recursive: true });
  await Bun.write(SETTINGS_PATH, JSON.stringify(updated, null, 2) + "\n");
  return result;
}
