// The Session type and small dependency-free helpers used across every file in this folder — kept
// separate so autoSummary.ts/extract.ts/search.ts don't need to import from index.ts (which itself
// re-exports them), avoiding a circular import.

export type Session = {
  id: string;
  projectSlug: string;
  cwd: string;
  gitBranch: string | null;
  firstMessage: string | null;
  userMessageSample: string[];
  messageCount: number;
  lastActive: number; // epoch ms
  sizeBytes: number;
  contextTokens: number | null;
  contextPct: number | null; // 0-100, null if unknown
  contextWindow: number | null; // the denominator actually used for contextPct
  changedFiles: string[];
  lastActivity: string | null; // last tool-use/thinking/text line seen — "what is it doing" for a running session
  lastUserMessage: string | null; // most recent real user turn — what a running session is working ON
};

// machine-generated user-role turns that aren't real human intent — task/tool notifications,
// injected system reminders, and the auto-generated recap that seeds a continued session. These
// contain keywords incidentally and pollute both search snippets and context digests.
export const NOISE_MESSAGE =
  /^(<task-notification|<system-reminder|<local-command|<command-|This session is being continued from a previous conversation|Caveat: The messages below were generated)/;

// Best-effort only — a real cwd can itself contain "-", making this ambiguous; the true cwd is
// read out of the transcript body instead whenever possible.
export function decodeProjectSlug(slug: string): string {
  return slug.replace(/^-/, "/").replace(/-/g, "/");
}

export function firstTextFromContent(content: unknown): string | null {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    for (const block of content) {
      if (block?.type === "text" && typeof block.text === "string") {
        return block.text;
      }
    }
  }
  return null;
}

export function projectNameFromCwd(cwd: string): string {
  const parts = cwd.split("/").filter(Boolean);
  return parts[parts.length - 1] || cwd;
}
