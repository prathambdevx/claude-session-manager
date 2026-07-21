// Prompt text builders for every flow that shells out to `claude` — launcher, context
// extraction/continuation, and agent delegation.
import { EFFORT_FLAG, DEFAULT_MODEL, EXTENDED_CONTEXT } from "../config.ts";
import { KNOWN_MODELS, DANGEROUS_FLAG, CLAUDE_BIN } from "../constants.ts";
import type { ContextRecord, Agent } from "../store.ts";
import { shellQuote } from "./tmux/terminalLauncher.ts";

// Sonnet and Opus support an extended 1M-context variant via a "[1m]" suffix on the model alias —
// but ONLY on accounts entitled to it, so it's gated behind EXTENDED_CONTEXT (see config.ts).
export function modelAliasWithContext(model: string): string {
  if (EXTENDED_CONTEXT && (model === "sonnet" || model === "opus")) return `${model}[1m]`;
  return model;
}

export function buildLaunchScript(
  task: string,
  opts: { model?: string | null; sessionId?: string | null; dangerous?: boolean } = {}
): string {
  const model = opts.model && KNOWN_MODELS.has(opts.model) ? opts.model : DEFAULT_MODEL;
  const modelFlag = ` --model ${shellQuote(modelAliasWithContext(model))}`;
  const sessionFlag = opts.sessionId ? ` --session-id ${opts.sessionId}` : "";
  const dangerFlag = opts.dangerous !== false ? DANGEROUS_FLAG : "";
  return `${shellQuote(CLAUDE_BIN)}${modelFlag}${EFFORT_FLAG}${sessionFlag}${dangerFlag} ${shellQuote(task)}`;
}

export function buildContextExtractionPrompt(digest: string): string {
  return (
    "Below is a condensed, chronological digest of a Claude Code session — USER messages, ASSISTANT replies, " +
    "and ASSISTANT tool-use actions (files edited, commands run). Some early history may be omitted for length; " +
    "focus on understanding the overall task and, especially, the most recent state.\n\n" +
    "--- TRANSCRIPT DIGEST ---\n" + digest + "\n--- END DIGEST ---\n\n" +
    "Summarize this session as a short, flat list of plain-English bullet points — nothing more. Just the key " +
    "points: what was being worked on, what actually got done, and where it's currently at / what's next. " +
    "8-12 bullets max, one sentence each, no sub-sections, no headers, no tables, no bold labels like " +
    "'Key decisions:' — just a plain markdown bullet list (`- point`), most important/recent things first. " +
    "Skip pleasantries and skip anything not needed to jog someone's memory about what happened."
  );
}

export function buildContinuationPrompt(ctx: ContextRecord): string {
  return (
    "You're continuing a previous session. Here is a condensed briefing of what happened and where it left off " +
    "— read it, then pick up exactly from \"Next steps\".\n\n--- CONTEXT BRIEFING ---\n" + ctx.markdown + "\n--- END BRIEFING ---"
  );
}

// The master→slave briefing prompt: the agent's own instruction, plus a self-contained digest of
// what the master session did and which files it changed. The agent can read the whole repo; the
// file list just focuses it.
export function buildDelegationPrompt(agent: Agent, briefing: string, changedFiles: string[]): string {
  const files = changedFiles.length
    ? changedFiles.map((f) => `- ${f}`).join("\n")
    : "(no file changes were detected in that session)";
  return (
    agent.prompt +
    "\n\n--- CONTEXT FROM THE SESSION YOU ARE CONTINUING ---\n" +
    briefing +
    "\n\nFiles that session changed (read/inspect whatever else in the repo you need — you are NOT limited to these):\n" +
    files +
    "\n--- END CONTEXT ---"
  );
}
