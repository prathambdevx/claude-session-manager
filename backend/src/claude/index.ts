// Everything that shells out to the `claude` CLI or the macOS Terminal, split by concern:
// - headless.ts       one-shot awaited calls
// - detachedRunner.ts  fire-and-forget background calls with streamed progress
// - terminal/          AppleScript/JXA-driven terminal window control — see its own files
// - prompts.ts         every prompt-text builder
// This barrel re-exports the same public surface the old single claude.ts file had, so external
// call sites (routes/*.ts, sessions.ts) don't need to know about the internal split.
export { runClaudeHeadless } from "./headless.ts";
export { runClaudeHeadlessDetached } from "./detachedRunner.ts";
export {
  shellQuote, ghosttyWindowTag, ghosttyWindowTitle, ghosttyTitleFilePath,
  writeGhosttyTitle, deleteGhosttyTitle, openTerminalRunning,
} from "./terminal/terminalLaunch.ts";
export { tryFocusRunningSession, closeRunningSessionTerminal } from "./terminal/terminalFocus.ts";
export { usingGhostty } from "./terminal/ghosttyEnv.ts";
export { sendPromptToRunningTerminal } from "./terminal/terminalInject.ts";
export {
  modelAliasWithContext, buildLaunchScript,
  buildContextExtractionPrompt, buildContinuationPrompt, buildDelegationPrompt,
} from "./prompts.ts";
