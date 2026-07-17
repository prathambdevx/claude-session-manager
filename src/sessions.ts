// Reading and analyzing Claude Code transcripts: scanning session metadata, building condensed
// digests, and the keyword/snippet search that powers both the quick and Claude-ranked searches.
import { readdir, readFile, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { PROJECTS_DIR, CONTEXT_WINDOW_TOKENS } from "./config.ts";
import { runClaudeHeadless } from "./claude.ts";

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
};

const WRITE_TOOLS = new Set(["Edit", "Write", "NotebookEdit"]);
const NOISE_PREFIX = /^<(local-command|command-name|command-message|command-stdout)/;
// machine-generated user-role turns that aren't real human intent — task/tool notifications,
// injected system reminders, and the auto-generated recap that seeds a continued session. These
// contain keywords incidentally and pollute both search snippets and context digests.
export const NOISE_MESSAGE =
  /^(<task-notification|<system-reminder|<local-command|<command-|This session is being continued from a previous conversation|Caveat: The messages below were generated)/;
const MAX_SAMPLE_MESSAGES = 8;

export function decodeProjectSlug(slug: string): string {
  // Best-effort only: Claude replaces "/" with "-" when slugifying cwd.
  // Real path may itself contain "-", so this is ambiguous — the true cwd
  // is read out of the transcript body instead whenever possible.
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

export async function scanTranscript(path: string, id: string, projectSlug: string): Promise<Session> {
  const st = await stat(path);
  const text = await readFile(path, "utf-8");
  const lines = text.split("\n").filter(Boolean);

  let cwd = decodeProjectSlug(projectSlug);
  let gitBranch: string | null = null;
  let firstMessage: string | null = null;
  const userMessageSample: string[] = [];
  let messageCount = 0;
  let lastContextTokens: number | null = null;
  const changedFiles = new Set<string>();

  for (const line of lines) {
    let d: any;
    try {
      d = JSON.parse(line);
    } catch {
      continue;
    }
    if (d.cwd && cwd === decodeProjectSlug(projectSlug)) cwd = d.cwd;
    if (d.gitBranch && !gitBranch) gitBranch = d.gitBranch;
    if (d.type === "user" || d.type === "assistant") messageCount++;
    if (d.type === "user" && d.message?.content && !d.isMeta) {
      const t = firstTextFromContent(d.message.content);
      const trimmed = t?.trim();
      if (trimmed && !NOISE_MESSAGE.test(trimmed)) {
        if (!firstMessage) firstMessage = trimmed;
        if (userMessageSample.length < MAX_SAMPLE_MESSAGES) {
          userMessageSample.push(trimmed.slice(0, 400));
        }
      }
    }
    if (d.type === "assistant" && Array.isArray(d.message?.content)) {
      for (const block of d.message.content) {
        if (block?.type === "tool_use" && WRITE_TOOLS.has(block.name) && typeof block.input?.file_path === "string") {
          changedFiles.add(block.input.file_path);
        }
      }
    }
    const usage = d.type === "assistant" ? d.message?.usage : null;
    if (usage) {
      const total =
        (usage.input_tokens ?? 0) +
        (usage.cache_creation_input_tokens ?? 0) +
        (usage.cache_read_input_tokens ?? 0);
      if (total > 0) lastContextTokens = total;
    }
  }

  const contextWindow = CONTEXT_WINDOW_TOKENS;
  const contextPct =
    lastContextTokens == null ? null : Math.min(100, Math.round((lastContextTokens / contextWindow) * 100));

  return {
    id,
    projectSlug,
    cwd,
    gitBranch,
    contextTokens: lastContextTokens,
    contextPct,
    contextWindow: lastContextTokens == null ? null : contextWindow,
    changedFiles: [...changedFiles],
    firstMessage,
    userMessageSample,
    messageCount,
    lastActive: st.mtimeMs,
    sizeBytes: st.size,
  };
}

export async function scanAllSessions(): Promise<Session[]> {
  if (!existsSync(PROJECTS_DIR)) return [];
  const projectDirs = await readdir(PROJECTS_DIR);
  const sessions: Session[] = [];

  await Promise.all(
    projectDirs.map(async (slug) => {
      const dir = join(PROJECTS_DIR, slug);
      let files: string[] = [];
      try {
        files = (await readdir(dir)).filter((f) => f.endsWith(".jsonl"));
      } catch {
        return;
      }
      await Promise.all(
        files.map(async (f) => {
          const id = f.replace(/\.jsonl$/, "");
          try {
            sessions.push(await scanTranscript(join(dir, f), id, slug));
          } catch {
            // unreadable/corrupt transcript — skip
          }
        })
      );
    })
  );

  return sessions;
}

// ---------- one-line auto-summary of a session ----------

export async function summarizeSession(s: Session): Promise<string> {
  const transcript = s.userMessageSample.join("\n---\n");
  const prompt =
    "Here are the first user messages from a coding-assistant session, in order. " +
    "In ONE short line (max 12 words, no period at the end, no quotes), describe what task the user was working on. " +
    "Be concrete and specific, not generic.\n\n" +
    transcript;
  const result = await runClaudeHeadless(prompt, { tools: "" });
  return result.split("\n")[0].trim().replace(/^["']|["']$/g, "").slice(0, 140);
}

// ---------- condensed transcript digest (for context extraction) ----------

// Builds a condensed, chronological digest of a transcript ourselves rather than pointing an agent
// at the raw .jsonl — some transcripts run several MB, way past what a single Read call should
// handle, and letting the agent page through it with tools was slow and unreliable on large files.
const DIGEST_CHAR_BUDGET = 120_000;
const DIGEST_ENTRY_MAX_CHARS = 600;

export async function buildTranscriptDigest(transcriptPath: string): Promise<string> {
  const text = await readFile(transcriptPath, "utf-8");
  const lines = text.split("\n").filter(Boolean);
  const entries: string[] = [];

  for (const line of lines) {
    let d: any;
    try {
      d = JSON.parse(line);
    } catch {
      continue;
    }
    if (d.type === "user" && d.message?.content && !d.isMeta) {
      const t = firstTextFromContent(d.message.content);
      const trimmed = t?.trim();
      if (trimmed && !NOISE_MESSAGE.test(trimmed)) {
        entries.push(`USER: ${trimmed.slice(0, DIGEST_ENTRY_MAX_CHARS)}`);
      }
    } else if (d.type === "assistant" && Array.isArray(d.message?.content)) {
      for (const block of d.message.content) {
        if (block?.type === "text" && block.text?.trim()) {
          entries.push(`ASSISTANT: ${block.text.trim().slice(0, DIGEST_ENTRY_MAX_CHARS)}`);
        } else if (block?.type === "tool_use") {
          const detail = block.input?.file_path || block.input?.command || block.input?.pattern || "";
          entries.push(`ASSISTANT used ${block.name}${detail ? `: ${String(detail).slice(0, 200)}` : ""}`);
        }
      }
    }
  }

  if (!entries.length) return "(no readable messages in this transcript)";

  // always keep the very first entry (the original task) for grounding, then fill the rest of the
  // budget with the most recent entries — what's near the end matters most for "where did this leave off"
  const first = entries[0];
  let used = first.length;
  const tail: string[] = [];
  for (let i = entries.length - 1; i >= 1 && used < DIGEST_CHAR_BUDGET; i--) {
    used += entries[i].length;
    tail.unshift(entries[i]);
  }
  const omitted = entries.length - 1 - tail.length;
  return [first, omitted > 0 ? `[... ${omitted} earlier messages omitted for length ...]` : null, ...tail]
    .filter(Boolean)
    .join("\n");
}

// ---------- keyword + snippet search ----------

const STOPWORDS = new Set([
  "the","a","an","this","that","these","those","is","was","were","are","be","been","being",
  "and","or","to","in","on","for","with","of","had","has","have","having","so","no","not",
  "it","its","as","like","i","im","was","able","just","also","then","than","there","here",
  "where","when","what","which","who","whom","do","does","did","done","can","could","would",
  "should","will","shall","may","might","must","we","you","your","my","me","us","our","they",
  "them","their","he","she","him","her","but","if","because","while","from","into","out","up",
  "down","over","under","again","once","some","any","all","each","other","such","only","own",
  "same","very","too","one",
]);

// words that describe the act of searching, not the thing being searched for — they'd match
// everything and drown out the meaningful terms, so drop them from the query needles
const SEARCH_MECHANICS = new Set([
  "find","found","search","searching","looking","look","session","sessions","chat","conversation",
  "remember","recall","refactored","refactor","earlier","previous","past","worked","working","did","made",
]);

export function queryNeedles(rawQuery: string, dropMechanics = false): string[] {
  const tokens = [
    ...new Set(
      rawQuery
        .split(/[^a-z0-9]+/)
        .filter((t) => t.length >= 3 && !STOPWORDS.has(t) && !(dropMechanics && SEARCH_MECHANICS.has(t)))
    ),
  ];
  return tokens.length ? tokens : [rawQuery];
}

// Pull the most-relevant snippets from a transcript: score every message by how many DISTINCT query
// terms it contains and return the densest ones (user messages weighted higher — the human's own
// request is the strongest signal), so a pivotal line deep in a huge session surfaces instead of
// whatever generic mention happens to appear first.
export async function matchSnippets(
  filePath: string,
  needles: string[],
  maxSnippets = 5
): Promise<{ snippets: string[]; density: number }> {
  let text: string;
  try {
    text = await readFile(filePath, "utf-8");
  } catch {
    return { snippets: [], density: 0 };
  }
  const scored: { score: number; snippet: string }[] = [];
  const seen = new Set<string>();
  for (const line of text.split("\n")) {
    let d: any;
    try {
      d = JSON.parse(line);
    } catch {
      continue;
    }
    const isUser = d.type === "user";
    let content: string | null = null;
    if (isUser && d.message?.content && !d.isMeta) content = firstTextFromContent(d.message.content);
    else if (d.type === "assistant" && Array.isArray(d.message?.content)) {
      const textBlock = d.message.content.find((b: any) => b?.type === "text" && b.text?.trim());
      content = textBlock?.text ?? null;
    }
    if (!content || NOISE_MESSAGE.test(content.trim())) continue;
    const lower = content.toLowerCase();
    const hits = needles.filter((n) => lower.includes(n));
    if (!hits.length) continue;
    const firstHit = Math.min(...hits.map((n) => lower.indexOf(n)));
    const start = Math.max(0, firstHit - 100);
    const snippet = content.slice(start, start + 300).replace(/\s+/g, " ").trim();
    if (!snippet || seen.has(snippet)) continue;
    seen.add(snippet);
    // co-occurrence in a single message is the signal — terms together in one line beat the same
    // terms scattered across a session. USER messages get a big boost: a search like "the session
    // where I did X" is recalling the human's own request, which lives in a user turn — so a user
    // line with 2 matching terms should outrank an assistant status line that happens to have 3
    // (and this survives the user's typos/word-variants that keyword matching alone would miss).
    const score = hits.length + (isUser ? 2 : 0);
    scored.push({ score, snippet: `${isUser ? "USER" : "ASSISTANT"}: ${snippet}` });
  }
  scored.sort((a, b) => b.score - a.score);
  return {
    snippets: scored.slice(0, maxSnippets).map((s) => s.snippet),
    density: scored.length ? scored[0].score : 0,
  };
}

export async function keywordSearchScores(rawQuery: string, matchRatio: number): Promise<Record<string, number>> {
  const needles = queryNeedles(rawQuery);
  const minMatches = Math.min(needles.length, Math.max(1, Math.ceil(needles.length * matchRatio)));
  const scores: Record<string, number> = {};
  if (!existsSync(PROJECTS_DIR)) return scores;
  const projectDirs = await readdir(PROJECTS_DIR);
  await Promise.all(
    projectDirs.map(async (slug) => {
      const dir = join(PROJECTS_DIR, slug);
      let files: string[] = [];
      try {
        files = (await readdir(dir)).filter((f) => f.endsWith(".jsonl"));
      } catch {
        return;
      }
      await Promise.all(
        files.map(async (f) => {
          try {
            const text = (await readFile(join(dir, f), "utf-8")).toLowerCase();
            const matched = needles.filter((n) => text.includes(n)).length;
            if (matched >= minMatches) scores[f.replace(/\.jsonl$/, "")] = matched;
          } catch {
            // unreadable transcript — skip
          }
        })
      );
    })
  );
  return scores;
}
