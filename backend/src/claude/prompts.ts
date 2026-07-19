// Prompt text builders for every flow that shells out to `claude` — launcher, reviewer, context
// extraction/continuation, and agent delegation.
import { EFFORT_FLAG, DEFAULT_MODEL, EXTENDED_CONTEXT } from "../config.ts";
import { KNOWN_MODELS, DANGEROUS_FLAG, CLAUDE_BIN } from "../constants.ts";
import type { ReviewRecord, ContextRecord, Agent } from "../store.ts";
import { shellQuote } from "./terminal/terminalLaunch.ts";

const REVIEW_PROMPT =
  "Review the uncommitted changes in this repo (git diff, plus any new untracked files) as a senior " +
  "engineer doing code review. Look specifically for: correctness bugs, edge cases that will break, " +
  "security vulnerabilities, and anything that looks unfinished or unsafe. List concrete findings with " +
  "file:line references. If everything looks solid, say so plainly instead of inventing nitpicks.";

function researchPrompt(task: string): string {
  return (
    "You are acting as a RESEARCH / THINKING agent, not an implementer. Do not write or edit any files. " +
    "Your job is to research and think through the following, then report back with a clear written " +
    "analysis and recommendation (options considered, tradeoffs, a concrete recommended plan): read " +
    "relevant existing code for context, search the web and read documentation/websites as needed, and " +
    "use any connected MCP tools that help gather accurate information. Do not implement anything — " +
    "just research, think, and report.\n\nTopic:\n" + task
  );
}

// Sonnet and Opus support an extended 1M-context variant via a "[1m]" suffix on the model alias —
// but ONLY on accounts entitled to it, so it's gated behind EXTENDED_CONTEXT (see config.ts).
export function modelAliasWithContext(model: string): string {
  if (EXTENDED_CONTEXT && (model === "sonnet" || model === "opus")) return `${model}[1m]`;
  return model;
}

export function buildLaunchScript(
  task: string,
  mode: string,
  opts: { model?: string | null; sessionId?: string | null; dangerous?: boolean } = {}
): string {
  const model = opts.model && KNOWN_MODELS.has(opts.model) ? opts.model : DEFAULT_MODEL;
  const modelFlag = ` --model ${shellQuote(modelAliasWithContext(model))}`;
  const sessionFlag = opts.sessionId ? ` --session-id ${opts.sessionId}` : "";
  const dangerFlag = opts.dangerous !== false ? DANGEROUS_FLAG : "";

  if (mode === "research") {
    // still blocked from mutating files even in dangerous mode — --disallowedTools is enforced independently
    return `${shellQuote(CLAUDE_BIN)}${modelFlag}${EFFORT_FLAG}${sessionFlag}${dangerFlag} --disallowedTools "Edit,Write,NotebookEdit" ${shellQuote(researchPrompt(task))}`;
  }

  const implementCmd = `${shellQuote(CLAUDE_BIN)}${modelFlag}${EFFORT_FLAG}${sessionFlag}${dangerFlag} ${shellQuote(task)}`;
  if (mode === "implement-review") {
    // the reviewer pass continues the same session (--continue) so it has full context of what was just built
    const reviewCmd = `${shellQuote(CLAUDE_BIN)}${modelFlag}${EFFORT_FLAG}${dangerFlag} --continue ${shellQuote(REVIEW_PROMPT)}`;
    return `${implementCmd} && echo '--- implementation done, launching reviewer agent ---' && ${reviewCmd}`;
  }
  return implementCmd;
}

export function buildFileReviewPrompt(files: string[], focus?: string): string {
  const list = files.map((f) => `- ${f}`).join("\n");
  const focusLine = focus
    ? `\nFOCUS: the user only wants this reviewed: "${focus}". From the files below, review only the parts ` +
      "relevant to that — ignore unrelated changes. If none of the files relate to it, say so plainly.\n"
    : "";
  return (
    "Review the following files, changed in a previous session, as an experienced senior engineer doing a " +
    "rigorous code review. Read each file in full and reason about how it behaves under real load and real " +
    "input, not just whether it looks plausible. Specifically watch for:\n" +
    "- Correctness bugs and edge cases that will break (empty inputs, nulls, off-by-one, concurrency/race conditions).\n" +
    "- Performance traps: N+1 queries, work inside loops that should be batched, missing indexes, redundant network/API calls, re-renders.\n" +
    "- Security: injection, missing auth/authorization checks, secrets in code, unsafe input handling.\n" +
    "- Resilience: unhandled errors, missing timeouts/retries, silent failure paths.\n" +
    "- Maintainability: dead code, duplication, unclear names, anything left unfinished or unsafe.\n" +
    focusLine +
    "\nWrite your findings as a clean Markdown report, for someone non-technical to still follow:\n" +
    "- Start with a one-paragraph plain-English summary of the overall state of these changes.\n" +
    "- Then list each problem as a numbered item: '1. <short plain-English title>' followed by 1-3 sentences " +
    "explaining the problem in simple words (no jargon), why it matters, and the file:line it's in.\n" +
    "- Number findings sequentially starting at 1 with no gaps, so they can be referenced by number later.\n" +
    "- If a file has no problems, say so plainly instead of inventing nitpicks — do not pad the list.\n" +
    "- Do not fix anything, do not edit any files — this is a report only.\n\n" +
    "Files:\n" + list
  );
}

export function buildFixPrompt(review: ReviewRecord, selection: "all" | number[], writeTests: boolean): string {
  const scope =
    selection === "all"
      ? "Fix ALL numbered findings in the review below."
      : `Fix ONLY finding(s) numbered ${selection.join(", ")} in the review below — leave every other finding untouched.`;
  let prompt =
    `${scope} Make the exact code changes needed in the real files to resolve them.\n\n` +
    "--- REVIEW REPORT ---\n" + review.markdown + "\n--- END REVIEW REPORT ---";
  if (writeTests) {
    prompt +=
      "\n\nAfter fixing, write test cases covering the fix(es) (using this project's existing test setup/conventions), " +
      "then run them and confirm they pass. Fix any test failures you introduce.";
  }
  return prompt;
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
