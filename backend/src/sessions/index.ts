// Reading and analyzing Claude Code transcripts. Split by concern: this file lists transcripts as
// Sessions; autoSummary.ts, details.ts, extract.ts hold the other analysis features and are
// re-exported here so every external import site keeps using one path (sessions/index.ts).
import { readdir, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, basename } from "node:path";
import { PROJECTS_DIR } from "../constants.ts";
import { mapLimit } from "../concurrency.ts";
import { loadProjectPathAliases, saveProjectPathAliases, retargetProjectColumns } from "../store.ts";
import { NOISE_MESSAGE, decodeProjectSlug, firstTextFromContent } from "./shared.ts";
import { scanLines } from "./lineReader.ts";
import { isLikelyProjectDir } from "./projectDetection.ts";
import { findCandidatesForBasename } from "./projectMoveDetection.ts";

export type { Session } from "./shared.ts";
export { decodeProjectSlug, firstTextFromContent, projectNameFromCwd, NOISE_MESSAGE } from "./shared.ts";
export { summarizeSession } from "./autoSummary.ts";
export { buildTranscriptDigest } from "./extract.ts";
export { readTranscriptDetails } from "./details.ts";

import type { Session } from "./shared.ts";

// Shared with routes/sessions.ts and fsWatcher.ts so both agree. Live testing showed Claude Code's
// own busy/idle status flips in sync with real completion, so this is just a short crash-safety
// margin now, not a long stale-status workaround.
export const ACTIVITY_WINDOW_MS = 1_000;
export function computeActivelyWorking(s: Session, running: { status?: string } | null | undefined): boolean {
  return running?.status === "busy" || Date.now() - s.lastActive < ACTIVITY_WINDOW_MS;
}

// What the list needs from a transcript's body, from its first lines only: the real cwd (the slug
// decode is ambiguous for hyphenated names), branch and first real user message.
type HeadInfo = { cwd: string | null; gitBranch: string | null; firstMessage: string | null; hasMessage: boolean; final: boolean; size: number };

const HEAD_CHUNK_BYTES = 64 * 1024;
const HEAD_MAX_BYTES = 1024 * 1024;
const FIRST_MESSAGE_MAX_CHARS = 1000;
const STAT_CONCURRENCY = 32;
const HEAD_CONCURRENCY = 4;

// Per transcript path; a head that found what it needs never changes, so it's read once per process.
const headCache = new Map<string, HeadInfo>();
// Last real cwd seen per project slug — fallback for a transcript whose head has no cwd line.
const slugCwds = new Map<string, string>();

export function releaseSessionCaches(): void {
  headCache.clear();
  slugCwds.clear();
}

export async function readTranscriptHead(path: string, size: number): Promise<HeadInfo> {
  const info: HeadInfo = { cwd: null, gitBranch: null, firstMessage: null, hasMessage: false, final: false, size };
  const onLine = (line: string) => {
    let d: any;
    try {
      d = JSON.parse(line);
    } catch {
      return;
    }
    if (d.cwd && !info.cwd) info.cwd = d.cwd;
    if (d.gitBranch && !info.gitBranch) info.gitBranch = d.gitBranch;
    if (d.type === "user" || d.type === "assistant") info.hasMessage = true;
    if (!info.firstMessage && d.type === "user" && d.message?.content && !d.isMeta) {
      const trimmed = firstTextFromContent(d.message.content)?.trim();
      if (trimmed && !NOISE_MESSAGE.test(trimmed)) info.firstMessage = trimmed.slice(0, FIRST_MESSAGE_MAX_CHARS);
    }
    if (info.cwd && info.firstMessage) return false;
  };
  const res = await scanLines(path, onLine, { chunkBytes: HEAD_CHUNK_BYTES, maxBytes: HEAD_MAX_BYTES });
  if (res.partial) onLine(res.partial);
  // Read again when the file grows only while it is still a short stub missing its first message.
  info.final = res.stopped;
  return info;
}

async function headFor(path: string, size: number): Promise<HeadInfo> {
  const cached = headCache.get(path);
  if (cached && (cached.final || cached.size === size)) return cached;
  const info = await readTranscriptHead(path, size);
  headCache.set(path, info);
  return info;
}

async function buildSession(path: string, id: string, projectSlug: string, st: { mtimeMs: number; size: number }): Promise<Session | null> {
  const head = await headFor(path, st.size);
  // A stub with no user/assistant turn in its first MB is not resumable (the old messageCount > 0 rule).
  if (!head.hasMessage && !head.final) return null;
  if (head.cwd) slugCwds.set(projectSlug, head.cwd);
  const cwd = head.cwd ?? slugCwds.get(projectSlug) ?? decodeProjectSlug(projectSlug);
  return {
    id,
    projectSlug,
    cwd,
    gitBranch: head.gitBranch,
    firstMessage: head.firstMessage,
    lastActive: st.mtimeMs,
    sizeBytes: st.size,
    isProjectDir: await isLikelyProjectDir(cwd),
  };
}

// One transcript's Session (fsWatcher's live refresh). Throws if the file is gone; null for a stub.
export async function scanTranscript(path: string, id: string, projectSlug: string): Promise<Session | null> {
  const st = await stat(path).catch((e) => {
    headCache.delete(path);
    throw e;
  });
  return buildSession(path, id, projectSlug, st);
}

// A folder that moved after its sessions were recorded would otherwise vanish from the board
// forever — remap through a known alias before the existence check (see loadProjectPathAliases).
export function resolveAliasedCwd(cwd: string, aliases: Record<string, string>): string {
  return !existsSync(cwd) && aliases[cwd] ? aliases[cwd] : cwd;
}

// A missing cwd with no unique match stays cached here for the process's lifetime, and one already
// being searched is tracked so a fast poll cadence can't pile up duplicate concurrent walks.
const autoDetectMisses = new Set<string>();
const autoDetectInFlight = new Set<string>();

// A leaf name reused by one of its own ancestors (e.g. .../bsc/bsc-pos/BSC) is unsafe to match by
// basename alone — confirmed live: this matched the outer "bsc" folder itself instead of the
// actual (no-longer-existing) "bsc-pos/BSC" subproject. Left for a manual "Project moved…" instead.
export function hasSelfReferentialName(cwd: string): boolean {
  const segments = cwd.split("/").filter(Boolean);
  const leaf = segments.at(-1)?.toLowerCase();
  return segments.slice(0, -1).some((seg) => seg.toLowerCase() === leaf);
}

// Fire-and-forget — a directory walk must never block the response a session list is served from.
// Persists a found alias for loadProjectPathAliases/resolveAliasedCwd to pick up on the NEXT scan;
// this scan's own results were already built before the search could possibly finish.
function autoHealMissingCwd(cwd: string): void {
  if (autoDetectMisses.has(cwd) || autoDetectInFlight.has(cwd) || hasSelfReferentialName(cwd)) return;
  autoDetectInFlight.add(cwd);
  findCandidatesForBasename(basename(cwd))
    .then(async (candidates) => {
      if (candidates.length === 1) {
        const aliases = await loadProjectPathAliases();
        aliases[cwd] = candidates[0];
        await saveProjectPathAliases(aliases);
        await retargetProjectColumns(cwd, candidates[0]);
      } else {
        autoDetectMisses.add(cwd); // 0 or >1 matches — too risky to guess, don't retry every tick
      }
    })
    .catch(() => {}) // best-effort; a failed walk just means this cwd stays hidden for now
    .finally(() => autoDetectInFlight.delete(cwd));
}

export async function scanAllSessions(): Promise<Session[]> {
  if (!existsSync(PROJECTS_DIR)) return [];
  const files: { path: string; id: string; slug: string }[] = [];
  for (const slug of await readdir(PROJECTS_DIR)) {
    let names: string[] = [];
    try {
      names = (await readdir(join(PROJECTS_DIR, slug))).filter((f) => f.endsWith(".jsonl"));
    } catch {
      continue;
    }
    for (const f of names) files.push({ path: join(PROJECTS_DIR, slug, f), id: f.replace(/\.jsonl$/, ""), slug });
  }
  const stats = await mapLimit(files, STAT_CONCURRENCY, (f) => stat(f.path).catch(() => null));
  const live = new Set(files.map((f) => f.path));
  for (const p of headCache.keys()) if (p.startsWith(PROJECTS_DIR) && !live.has(p)) headCache.delete(p);
  const built = await mapLimit(files, HEAD_CONCURRENCY, (f, i) => {
    const st = stats[i];
    // unreadable/corrupt transcript — skip
    return st ? buildSession(f.path, f.id, f.slug, st).catch(() => null) : Promise.resolve(null);
  });
  const sessions = built.filter((s): s is Session => !!s);

  const aliases = await loadProjectPathAliases();
  for (const s of sessions) s.cwd = resolveAliasedCwd(s.cwd, aliases);

  // Still missing after the known-alias pass? Kick off a background search — a moved folder is
  // common enough (reorganizing into a shared parent, renaming a workspace) that requiring a
  // manual "this moved" click for every one would defeat the point. Doesn't affect this scan's
  // own results; a found alias shows up starting the next one.
  for (const s of sessions) {
    if (!existsSync(s.cwd)) autoHealMissingCwd(s.cwd);
  }

  // A folder that no longer exists can't be resumed into, so don't surface it.
  return sessions.filter((s) => existsSync(s.cwd));
}
