// Everything that shells out to the `claude` CLI or drives a terminal, split by concern:
// - headless.ts       one-shot awaited calls
// - detachedRunner.ts  fire-and-forget background calls with streamed progress
// - tmux/              tmux-backed session/pane management + terminal launching — see its own files
// - prompts.ts         every prompt-text builder
// This barrel re-exports the same public surface the old single claude.ts file had, so external
// call sites (routes/*.ts, sessions.ts) don't need to know about the internal split.
export { runClaudeHeadless } from "./headless.ts";
export { runClaudeHeadlessDetached } from "./detachedRunner.ts";
export { paneArgv, sendKeys, isTmuxAvailable } from "./tmux/tmux.ts";
export { grids, startTmuxReconciliationPoller, GridManager } from "./tmux/grids.ts";
export type { GridId, PaneEntry, Grid } from "./tmux/grids.ts";
export {
  shellQuote, resolveTerminalApp, detectTerminalFromEnv, saveTerminalConfig,
  openTerminalForGrid, focusTerminalApp, focusGridWindow,
} from "./tmux/terminalLauncher.ts";
export type { TerminalApp } from "./tmux/terminalLauncher.ts";
export {
  modelAliasWithContext, buildLaunchScript,
  buildContextExtractionPrompt, buildContinuationPrompt, buildDelegationPrompt,
} from "./prompts.ts";
