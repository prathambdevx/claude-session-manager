// Everything that shells out to the `claude` CLI or the macOS Terminal, split by concern:
// - headless.ts       one-shot awaited calls
// - detachedRunner.ts  fire-and-forget background calls with streamed progress
// - terminalLaunch.ts  launching a new interactive session window + Ghostty title bookkeeping
// - terminalFocus.ts   bringing an existing session's window to the front
// - terminalInject.ts  Quick Prompt's deliver-into-an-open-terminal path
// - prompts.ts         every prompt-text builder
// This barrel re-exports the same public surface the old single claude.ts file had, so external
// call sites (routes/*.ts, sessions.ts) don't need to know about the internal split.
export { runClaudeHeadless } from "./headless.ts";
export { runClaudeHeadlessDetached } from "./detachedRunner.ts";
export {
  shellQuote, ghosttyWindowTag, ghosttyWindowTitle, ghosttyTitleFilePath,
  writeGhosttyTitle, deleteGhosttyTitle, openTerminalRunning,
} from "./terminalLaunch.ts";
export { tryFocusRunningSession, closeRunningSessionTerminal } from "./terminalFocus.ts";
export { usingGhostty } from "./ghosttyEnv.ts";
export { sendPromptToRunningTerminal } from "./terminalInject.ts";
export {
  modelAliasWithContext, buildLaunchScript, buildFileReviewPrompt, buildFixPrompt,
  buildContextExtractionPrompt, buildContinuationPrompt, buildDelegationPrompt,
} from "./prompts.ts";
