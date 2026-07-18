// Configure your default model and effort level to open new terminals with,
import { SUPPORTS_EFFORT } from "./claude/effortSupport.ts";

export const DEFAULT_MODEL = "sonnet"; // sonnet | opus
export const DEFAULT_EFFORT = "medium"; // low | medium | high
export const EXTENDED_CONTEXT = true; // 1M-context model variant — needs a plan with real access to it

// Omitted entirely on older `claude` CLI installs that don't recognize the flag yet.
export const EFFORT_FLAG = SUPPORTS_EFFORT ? ` --effort ${DEFAULT_EFFORT}` : "";
export const CONTEXT_WINDOW_TOKENS = EXTENDED_CONTEXT ? 1_000_000 : 200_000;

//`bun run config` , after changing the above, will write these into ~/.claude/settings.json so they apply everywhere you run `claude`, not just from this app.
