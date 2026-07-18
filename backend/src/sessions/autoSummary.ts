// One-line auto-summary of a session (the ✦ button on a card) — a cheap headless Haiku call, no
// tools, over a small sample of the transcript rather than the whole thing.
import { runClaudeHeadless } from "../claude/index.ts";
import type { Session } from "./shared.ts";

// Head+tail sampling (not just the first N) so a summary reflects where a session ENDED UP too.
const SAMPLE_HEAD_MESSAGES = 4;
const SAMPLE_TAIL_MESSAGES = 4;

export function sampleUserMessages(allUserMessages: string[]): string[] {
  if (allUserMessages.length <= SAMPLE_HEAD_MESSAGES + SAMPLE_TAIL_MESSAGES) return allUserMessages;
  return [
    ...allUserMessages.slice(0, SAMPLE_HEAD_MESSAGES),
    "(…conversation continues…)",
    ...allUserMessages.slice(-SAMPLE_TAIL_MESSAGES),
  ];
}

export async function summarizeSession(s: Session): Promise<string> {
  const transcript = s.userMessageSample.join("\n---\n");
  const filesNote = s.changedFiles.length
    ? `\n\nFiles actually changed in this session: ${s.changedFiles.slice(0, 12).join(", ")}`
    : "";
  const prompt =
    "Here are messages from a coding-assistant session — the earliest ones (the original ask), " +
    "then a gap, then the most recent ones (where the conversation ended up; it may have pivoted " +
    "far from the original ask, which is common)." +
    filesNote +
    "\n\nIn ONE short line (max 12 words, no period at the end, no quotes), describe what this " +
    "session actually did, prioritizing the ending and the changed files over the opening ask if " +
    "they differ. Be concrete and specific (mention the real feature/file/bug), not generic.\n\n" +
    transcript;
  const result = await runClaudeHeadless(prompt, { tools: "" });
  return result.split("\n")[0].trim().replace(/^["']|["']$/g, "").slice(0, 140);
}
