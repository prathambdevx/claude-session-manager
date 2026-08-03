// `bun run config` — CLI wrapper around src/syncClaudeSettings.ts. Also run automatically on
// install and every auto-update (see setup.ts, src/polling/autoUpdater.ts) so teammates get this
// without ever needing to know the command exists.
import { syncClaudeSettings } from "./src/syncClaudeSettings.ts";
import { DEFAULT_MODEL, DEFAULT_EFFORT, EXTENDED_CONTEXT } from "./src/config.ts";

const result = await syncClaudeSettings();

console.log("Syncing this app's config into your real Claude Code settings:");
console.log(`  ${result.path}`);
console.log("");
console.log(`  model:        ${JSON.stringify(result.previousModel)} -> ${JSON.stringify(result.newModel)}`);
console.log(`  effortLevel:  ${JSON.stringify(result.previousEffort)} -> ${JSON.stringify(DEFAULT_EFFORT)}`);
if (!EXTENDED_CONTEXT && (DEFAULT_MODEL === "sonnet" || DEFAULT_MODEL === "opus")) {
  console.log("");
  console.log("  (extendedContext is off in data/settings.json — writing the plain alias, no [1m])");
}
console.log("");
console.log("✓ Done — every other key in that file (permissions, hooks, plugins, theme, ...) was left as-is.");
