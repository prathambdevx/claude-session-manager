// Reading and analyzing Claude Code transcripts. Split by concern: this file scans transcripts into
// Sessions; autoSummary.ts, extract.ts, search.ts hold the other analysis features and are
// re-exported here so every external import site keeps using one path (sessions/index.ts).
import { readdir, readFile, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { CONTEXT_WINDOW_TOKENS } from "../config.ts";
import { PROJECTS_DIR } from "../constants.ts";
import { activityLine } from "../claude/activity.ts";
import { StatCache } from "../cache.ts";
import { NOISE_MESSAGE, decodeProjectSlug, firstTextFromContent } from "./shared.ts";
import { sampleUserMessages } from "./autoSummary.ts";

export type { Session } from "./shared.ts";
export { decodeProjectSlug, firstTextFromContent, projectNameFromCwd, NOISE_MESSAGE } from "./shared.ts";
export { summarizeSession } from "./autoSummary.ts";
export { buildTranscriptDigest } from "./extract.ts";
export { queryNeedles, matchSnippets, keywordSearchScores } from "./search.ts";

import type { Session } from "./shared.ts";

// Shared with routes/sessions.ts and fsWatcher.ts so both agree. Live testing showed Claude Code's
// own busy/idle status flips in sync with real completion, so this is just a short crash-safety
// margin now, not a long stale-status workaround.
export const ACTIVITY_WINDOW_MS = 3_000;
export function computeActivelyWorking(s: Session, running: { status?: string } | null | undefined): boolean {
  return running?.status === "busy" || Date.now() - s.lastActive < ACTIVITY_WINDOW_MS;
}

const WRITE_TOOLS = new Set(["Edit", "Write", "NotebookEdit"]);

// Caches each Session by its transcript's mtime/size so an unchanged file (almost all of them,
// most polls) costs a stat() instead of a full re-parse.
const transcriptCache = new StatCache<Session>();

export async function scanTranscript(path: string, id: string, projectSlug: string): Promise<Session> {
  const st = await stat(path);
  const cached = transcriptCache.get(path, st.mtimeMs, st.size);
  if (cached) return cached;
  const text = await readFile(path, "utf-8");
  const lines = text.split("\n").filter(Boolean);

  let cwd = decodeProjectSlug(projectSlug);
  let gitBranch: string | null = null;
  let firstMessage: string | null = null;
  const allUserMessages: string[] = [];
  let messageCount = 0;
  let lastContextTokens: number | null = null;
  let lastActivity: string | null = null;
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
        allUserMessages.push(trimmed.slice(0, 400));
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
    // Compaction writes this marker the instant it finishes, well before the next real assistant
    // turn — reading it here means the % drops immediately instead of staying stuck at the
    // pre-compact value until a new usage entry eventually shows up.
    if (d.type === "system" && d.subtype === "compact_boundary" && typeof d.compactMetadata?.postTokens === "number") {
      lastContextTokens = d.compactMetadata.postTokens;
    }
    // last one wins — reflects the most recent thing this session did, for a running session's
    // live-activity chip. Piggybacks on this same pass instead of re-reading the file.
    const line2 = activityLine(d);
    if (line2) lastActivity = line2;
  }

  // No field records which context window a turn used, but real usage over 200K proves it ran
  // extended (a 200K model can't hold that much) — makes the % denominator correct per-session,
  // even mid-session model switches.
  const contextWindow =
    lastContextTokens != null && lastContextTokens > 200_000 ? 1_000_000 : CONTEXT_WINDOW_TOKENS;
  const contextPct =
    lastContextTokens == null ? null : Math.min(100, Math.round((lastContextTokens / contextWindow) * 100));

  const session: Session = {
    id,
    projectSlug,
    cwd,
    gitBranch,
    contextTokens: lastContextTokens,
    contextPct,
    contextWindow: lastContextTokens == null ? null : contextWindow,
    changedFiles: [...changedFiles],
    firstMessage,
    userMessageSample: sampleUserMessages(allUserMessages),
    messageCount,
    lastActive: st.mtimeMs,
    sizeBytes: st.size,
    lastActivity,
  };

  transcriptCache.set(path, st.mtimeMs, st.size, session);
  return session;
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
