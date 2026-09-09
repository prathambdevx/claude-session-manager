// Rolling, FULL-COVERAGE per-session summary — the data the Master Router reads instead of
// transcripts.
//
// Why not reuse buildTranscriptDigest or the ✦ auto-summary: both are endpoint-biased. The
// auto-summary samples the first 4 + last 4 user messages; buildTranscriptDigest keeps the first
// entry then fills a 120K-char budget from the END backwards and prints "[... N earlier messages
// omitted ...]". Both are right for a card label ("what did this session do") and wrong for
// routing, because the work a task should be routed to is usually in the MIDDLE. A session that
// spent 35 turns on discount/total logic and ended on a CSS fix summarizes as "fixed a margin"
// and would never be offered a discount task.
//
// So: summarize in fixed-size chunks as the transcript grows, once each, forever. Coverage is
// complete and the model cost over a session's whole life is O(conversation size) — measured
// ceiling ~350K tokens for the largest session on this machine, spread across weeks.
//
// The trailing partial chunk is deliberately NOT summarized here — the router reads those bytes
// raw (see readRawTail). That keeps the most routing-relevant content perfectly fresh at zero
// cost, instead of a stale summary of a half-finished span.
import { readFile, stat, rename } from "node:fs/promises";
import { join } from "node:path";
import { ROUTING_DIGESTS_DIR } from "../constants.ts";
import { runClaudeHeadless } from "../claude/index.ts";
import { askPool, poolReady, HAIKU } from "../claude/warmPool.ts";
import { scanEntriesFrom } from "../sessions/entries.ts";

/**
 * Chars of conversation per summarized chunk.
 *
 * Sized by COVERAGE, not by Haiku's context limit (12K chars is ~3K tokens — nowhere near the 200K
 * window). At 40K a median session on this machine accumulated zero complete chunks, so the router
 * saw only its raw tail and the middle went unread — reintroducing exactly the blindness this
 * module exists to fix. Smaller chunks mean more `claude` invocations, but each byte is still
 * summarized exactly once, so total work is unchanged; only the per-call overhead multiplies, and
 * that is paid by a background trickle rather than by anyone waiting.
 */
export const CHUNK_CHARS = 12_000;
/**
 * Floor for summarizing a SETTLED under-full span (see catchUpDigest). Above TAIL_RAW_CHARS,
 * because a span the raw tail already shows in full needs no summary; below CHUNK_CHARS, because
 * the whole point is covering sessions that never reach a chunk boundary.
 */
export const MIN_CHUNK_CHARS = 2_000;
/**
 * How long a transcript must be untouched before its under-full trailing span is summarized rather
 * than left for a boundary it may never cross. Short sessions simply end; waiting for 12K chars
 * that never arrive left them visible only through the 1,200-char raw tail.
 */
export const IDLE_SETTLE_MS = 3 * 60 * 1000;
/** verbatim chunk summaries kept before the oldest get folded into `earlier` */
/**
 * Raised from 5 based on a real latency sweep at the router's realistic candidate ceiling (15
 * sessions, per project decision): chunk count and `earlier` length barely moved decision latency
 * across the whole tested range (9.8-13.6s regardless, 5-50 chunks/candidate) — candidate COUNT was
 * the dominant cost, not per-candidate content size. 20 covers most sessions' full history with no
 * folding at all (Production Module: 11 total, Strapi blocks: 11), and covers 20*12,000=240,000
 * chars (~60K tokens) verbatim for longer ones before `earlier` kicks in — 4x the old ceiling.
 */
/** Traded jointly against MAX_CANDIDATES (8) against a 10s decision-latency ceiling — see
 *  docs/master-session-router.md. 12 covers 144,000 chars (~36K tokens) verbatim, still 2.4x the
 *  original 5, while leaving room in the per-candidate budget for `earlier`. */
export const MAX_KEPT_CHUNKS = 12;
/**
 * Raw trailing conversation handed to the router per session — fresh, unsummarized, no model call.
 * Kept deliberately short: this is multiplied by every candidate in the routing prompt, so it's the
 * term that dominates prompt size (and therefore decision latency). Coverage of everything older
 * is the chunks' job, not this.
 */
export const TAIL_RAW_CHARS = 1_200;
/** cap on tracked files per session, newest-first */
const MAX_FILES = 40;

export type DigestChunk = {
  from: number;
  to: number;
  /** WORK line — what was built/fixed, with identifiers and paths */
  summary: string;
  /**
   * TOPICS line — search terms, each domain concept given BOTH its code name and its everyday
   * name ("cart, basket", "OTP, one-time password"). This is the paraphrase bridge: it lets a user
   * typing "basket" reach a session whose code only ever says "cart", with no synonym table.
   * Scored at ordinary summary-text weight, never higher — Haiku will occasionally invent a
   * plausible-but-wrong alias, and a lexical hit on an invented term is a false positive.
   */
  topics?: string;
};

export type RoutingDigest = {
  sessionId: string;
  /** byte offset past the last COMPLETE summarized chunk — the resume watermark */
  coveredBytes: number;
  /** entries summarized so far; provenance for chunk from/to, not used for resuming */
  coveredEntries: number;
  /** folded summary of chunks older than the MAX_KEPT_CHUNKS most recent */
  earlier: string;
  chunks: DigestChunk[];
  files: string[];
  updatedAt: number;
  /**
   * Same instant as `updatedAt`, rendered for humans reading these files by hand — an epoch
   * milliseconds integer is unreadable at a glance. Pinned to Asia/Kolkata rather than the host
   * timezone so the value means the same thing wherever it is read back.
   */
  updatedAtLocal: string;
};

/** e.g. "2 Sep 2026, 3:05 AM" — IST, matching how these files get read in practice. */
export function istStamp(ms: number): string {
  if (!ms) return "";
  const d = new Date(ms);
  const opts = { timeZone: "Asia/Kolkata" } as const;
  // Built from parts rather than one toLocaleString call: en-GB renders "2 Sep 2026 at 4:06 am"
  // (lowercase, "at" separator) and en-US renders "Sep 2, 2026" (month first). Neither matches
  // "2 Sep 2026, 4:06 AM".
  const date = d.toLocaleDateString("en-GB", { ...opts, day: "numeric", month: "short", year: "numeric" });
  const time = d
    .toLocaleTimeString("en-US", { ...opts, hour: "numeric", minute: "2-digit", hour12: true })
    .toUpperCase();
  return `${date}, ${time}`;
}

function empty(sessionId: string): RoutingDigest {
  return { sessionId, coveredBytes: 0, coveredEntries: 0, earlier: "", chunks: [], files: [], updatedAt: 0, updatedAtLocal: "" };
}

const digestPath = (sessionId: string) => join(ROUTING_DIGESTS_DIR, `${sessionId}.json`);

/** Thrown when a digest file exists but cannot be parsed — distinct from "no digest yet". */
export class CorruptDigestError extends Error {}

export async function loadDigest(sessionId: string): Promise<RoutingDigest | null> {
  let raw: string;
  try {
    raw = await readFile(digestPath(sessionId), "utf-8");
  } catch {
    return null; // genuinely absent
  }
  try {
    return JSON.parse(raw);
  } catch {
    // A truncated file must NOT read as "no digest": catchUpDigest would fall back to empty(),
    // overwrite `earlier` and every chunk, and reset coveredBytes to 0 — silently destroying the
    // history and re-spending ~120 Haiku calls on the largest session.
    throw new CorruptDigestError(`unparseable digest for ${sessionId}`);
  }
}

export async function saveDigest(d: RoutingDigest): Promise<void> {
  // Write-then-rename: Bun.write truncates first, so a crash or `bun run restart` mid-write left a
  // truncated file. rename(2) is atomic within a filesystem, so a reader sees either the old
  // complete file or the new one, never a partial.
  const final = digestPath(d.sessionId);
  const tmp = `${final}.${process.pid}.tmp`;
  await Bun.write(tmp, JSON.stringify(d, null, 2));
  await rename(tmp, final);
}

/**
 * One Haiku call for digest work. Uses a warm slot when the pool is up — the CLI's ~7.5s startup was
 * roughly half of every ~17s chunk, paid again for each one — and falls back to a cold spawn
 * otherwise, which is always correct and only slower.
 */
async function haiku(prompt: string, timeoutMs = 60_000): Promise<string> {
  if (poolReady(HAIKU)) {
    try {
      return await askPool(HAIKU, prompt, timeoutMs);
    } catch {
      // pool slot died mid-flight — fall through rather than losing the chunk
    }
  }
  return runClaudeHeadless(prompt, { tools: "", timeoutMs });
}

function parseLabelled(out: string, kind = "chunk"): { summary: string; topics: string } {
  // tolerate markdown decoration ("**WORK:**") and leading list markers
  const work = out.match(/^\s*[*#>\-\s]*WORK\s*:?\**\s*(.+)$/im)?.[1]?.trim();
  const topics = out.match(/^\s*[*#>\-\s]*TOPICS\s*:?\**\s*(.+)$/im)?.[1]?.trim() ?? "";
  if (work) return { summary: work.replace(/\*+/g, "").slice(0, 500), topics: topics.slice(0, 400) };  // chunk cap unchanged

  // DEGRADE, never discard. Requiring the label was fatal: a format miss threw, catchUpDigest hit
  // its `break`, and the whole pass stored nothing — measured as sessions burning 30-80s of model
  // calls and ending with chunks=0, permanently digest-less. A roughly-formatted summary is worth
  // far more than no coverage, so fall back to the raw text with the old first-person cleanup and
  // log it loudly enough to notice.
  const salvaged = out
    .trim()
    .replace(/^(I|We)['a-z ]*[:,] ?/i, "")
    .replace(/\s+/g, " ")
    .slice(0, 500);
  if (!salvaged) throw new Error(`${kind} summary was empty`);
  console.warn(`[routing] ${kind} summary missing WORK label — salvaged raw output`);
  return { summary: salvaged, topics: "" };
}

async function summarizeChunk(text: string): Promise<{ summary: string; topics: string }> {
  const prompt =
    "Below is a span from the middle of a coding-assistant session's transcript. " +
    "It may begin or end mid-turn; ignore the fragments.\n\n" +
    "Output EXACTLY two labelled lines, nothing else:\n" +
    "WORK: at most 35 words, third person. Name the feature or bug, the code identifiers and " +
    'functions, and the file paths touched (e.g. "fixed cartLinesRemove idempotency in ' +
    'services/shopify/storefront/cart.ts"). No preamble, no bullets, no markdown, no "files ' +
    "touched\" list, and never quote or continue the transcript's speakers.\n" +
    "TOPICS: 6-12 comma-separated search terms someone would type to find this work later. For " +
    "every domain concept give BOTH the code's own name and the everyday words for the same thing " +
    "(cart, basket; OTP, one-time password, verification code; wishlist, favourites, saved items). " +
    "Include the product area, page, and endpoint. No file paths. Exclude generic words: test, " +
    "fix, refactor, commit, PR, deploy, typecheck, verify.\n\n" +
    text;
  const out = await haiku(prompt);
  return parseLabelled(out);
}

async function foldEarlier(existing: string, dropped: DigestChunk[]): Promise<string> {
  const prompt =
    "Condense these summaries of earlier parts of ONE coding session.\n\n" +
    "Output EXACTLY two labelled lines:\n" +
    "WORK: at most 120 words. Merge into the distinct areas of work. Keep every feature name, code " +
    "identifier, file path and PR number. Drop chronology, ordering, test/lint/commit/deploy " +
    "steps, and anything said twice.\n" +
    "TOPICS: the deduplicated union of the TOPICS terms below, at most 25, comma-separated.\n\n" +
    [existing, ...dropped.map((c) => `WORK: ${c.summary}${c.topics ? `\nTOPICS: ${c.topics}` : ""}`)]
      .filter(Boolean)
      .join("\n");
  try {
    const out = await haiku(prompt);
    // Fold gets a WIDER cap than a chunk summary (see the "no crash up to 16,000 chars/candidate
    // at 15-candidate scale" sweep result) — it's one field, not one per chunk, and it's the only
    // representation of everything older than MAX_KEPT_CHUNKS, so it can afford to hold more.
    const parsed = parseLabelled(out, "fold");
    // `earlier` is the lossiest field in a digest (one paragraph standing in for everything
    // beyond MAX_KEPT_CHUNKS) — it gets a smaller share of the per-candidate budget than verbatim
    // chunks get, since a byte of real chunk text carries more routing signal than a byte of fold.
    const summary = parsed.summary.slice(0, 1200);
    const topics = parsed.topics.slice(0, 600);
    return topics ? `${summary}\nTOPICS: ${topics}` : summary;
  } catch {
    // a failed fold must not lose history or wedge the watermark — keep the raw concatenation,
    // trimmed. It'll get folded properly on the next catch-up.
    return [existing, ...dropped.map((c) => c.summary)].filter(Boolean).join(" ").slice(0, 1500);
  }
}

/**
 * Bring `sessionId`'s digest up to date, summarizing only spans not already covered.
 *
 * Returns the digest unchanged (no model calls, one stat) when the transcript hasn't grown by a
 * full chunk — which is the common case, so this is cheap to call often.
 */
export async function catchUpDigest(
  sessionId: string,
  transcriptPath: string,
  /**
   * Cap on chunks summarized in this pass. A long-neglected session can have dozens of pending
   * chunks; without a cap the first pass over it would run for minutes and hold the worker. The
   * uncovered remainder just gets picked up next pass, and the router still sees the raw tail
   * meanwhile, so partial coverage is never a correctness problem.
   */
  maxChunks = Infinity
): Promise<RoutingDigest> {
  // A CorruptDigestError propagates deliberately: the worker logs and skips, rather than
  // "recovering" by discarding the session's whole history.
  let d = (await loadDigest(sessionId)) ?? empty(sessionId);

  let size: number;
  let mtimeMs: number;
  try {
    const st = await stat(transcriptPath);
    size = st.size;
    mtimeMs = st.mtimeMs;
  } catch {
    return d; // transcript gone
  }
  // Shrunk rather than appended to => the file was rewritten/truncated and every stored offset is
  // meaningless. Rebuilding is the only safe move; a stale offset would silently summarize the
  // wrong spans from here on.
  if (size < d.coveredBytes) d = empty(sessionId);
  if (size === d.coveredBytes) return d;

  // A session that has stopped being written to will never reach another chunk boundary, so its
  // trailing span has to be summarized on idleness instead of on size — otherwise a short session
  // stays permanently invisible past its 1,200-char raw tail.
  const settled = Date.now() - mtimeMs > IDLE_SETTLE_MS;

  const { entries, files } = await scanEntriesFrom(transcriptPath, d.coveredBytes);
  if (!entries.length) return d;

  // Batch into complete CHUNK_CHARS spans. While a session is actively growing, a trailing
  // under-full batch is left for next time and readRawTail serves it verbatim.
  const batches: { text: string; endByte: number; count: number }[] = [];
  let buf: string[] = [];
  let chars = 0;
  let count = 0;
  for (const e of entries) {
    buf.push(e.text);
    chars += e.text.length + 1;
    count++;
    if (chars >= CHUNK_CHARS) {
      batches.push({ text: buf.join("\n"), endByte: e.endByte, count });
      buf = [];
      chars = 0;
      count = 0;
    }
  }

  // Settled session with a leftover span worth summarizing: take it as a final, short chunk. This
  // is what covers sessions whose whole conversation is under CHUNK_CHARS. Deliberately gated on
  // `settled` rather than applied always — doing it eagerly would summarize a growing session in
  // small increments and multiply the call count for no coverage gain, and it would also consume
  // the raw tail that carries "what is this session doing right now".
  if (buf.length && settled && chars >= MIN_CHUNK_CHARS) {
    batches.push({ text: buf.join("\n"), endByte: entries[entries.length - 1].endByte, count });
  }

  if (!batches.length) {
    // no complete chunk yet — still record any newly-seen files, they're free and whole-session
    if (files.length) {
      d.files = [...new Set([...files, ...d.files])].slice(0, MAX_FILES);
      d.updatedAt = Date.now();
      d.updatedAtLocal = istStamp(d.updatedAt);
      await saveDigest(d);
    }
    return d;
  }

  const todo = batches.slice(0, maxChunks === Infinity ? batches.length : maxChunks);

  // SEQUENTIAL, deliberately.
  //
  // An earlier version summarized these in parallel windows. It was measurably worse on both counts:
  // a warm process serves exactly one prompt (context accumulates), so N chunks need N boots however
  // they are scheduled, and concurrent boots contend — 3-way against a 4-slot pool ran 30.6s/chunk
  // versus 16.7s/chunk sequential. Worse, batching broke partial progress: one failure in the first
  // window committed NOTHING, where this loop commits every chunk up to the failure. Measured on a
  // 95-chunk session, the parallel version committed 0 chunks after 170s.
  //
  // Parallelism belongs ACROSS sessions (see CONCURRENCY in worker.ts), not within one — that is
  // also the axis that matters for keeping several live sessions' digests fresh.
  for (const b of todo) {
    let parsed: { summary: string; topics: string };
    try {
      parsed = await summarizeChunk(b.text);
    } catch {
      // Leave coveredBytes where it is and stop: this span retries on the next catch-up. Advancing
      // past an unsummarized chunk would punch a permanent hole in coverage.
      break;
    }
    d.chunks.push({ from: d.coveredEntries, to: d.coveredEntries + b.count, summary: parsed.summary, topics: parsed.topics });
    d.coveredEntries += b.count;
    d.coveredBytes = b.endByte;
  }

  if (d.chunks.length > MAX_KEPT_CHUNKS) {
    const dropped = d.chunks.slice(0, d.chunks.length - MAX_KEPT_CHUNKS);
    d.chunks = d.chunks.slice(-MAX_KEPT_CHUNKS);
    d.earlier = await foldEarlier(d.earlier, dropped);
  }

  d.files = [...new Set([...files, ...d.files])].slice(0, MAX_FILES);
  d.updatedAt = Date.now();
  d.updatedAtLocal = istStamp(d.updatedAt);
  await saveDigest(d);
  return d;
}

/**
 * The un-summarized trailing conversation, read live. No model call and never stale — this is what
 * a session is doing RIGHT NOW, which is the strongest routing signal there is.
 */
export async function readRawTail(transcriptPath: string, fromByte: number): Promise<string> {
  try {
    const size = Bun.file(transcriptPath).size;
    // Never scan from 0. With no digest yet, fromByte is 0, and scanning from there slurped the
    // ENTIRE transcript into memory and parsed it line-by-line just to produce 1,200 chars — for
    // every candidate, on every debounced keystroke of the live hint. With a 203 MB and two ~40 MB
    // transcripts in the recent set that was ~290 MB read and parsed per hint.
    //
    // Conversation is ~1% of raw bytes (the rest is tool results), so this window is sized ~500x
    // the chars we need. If it still comes up short, the tail is simply shorter than the cap —
    // which costs nothing, since the chunks cover everything older anyway.
    const window = TAIL_RAW_CHARS * 500;
    const start = Math.max(fromByte, size - window);
    const { entries } = await scanEntriesFrom(transcriptPath, start, start > fromByte);
    if (!entries.length) return "";
    const text = entries.map((e) => e.text).join("\n");
    return text.length > TAIL_RAW_CHARS ? text.slice(-TAIL_RAW_CHARS) : text;
  } catch {
    return "";
  }
}

/** True when enough new conversation exists to be worth a summarization pass. */
export async function hasPendingChunk(sessionId: string, transcriptPath: string): Promise<boolean> {
  const d = await loadDigest(sessionId);
  const covered = d?.coveredBytes ?? 0;
  let size: number;
  try {
    size = Bun.file(transcriptPath).size;
  } catch {
    return false;
  }
  if (size < covered) return true; // rewritten — needs a rebuild
  if (size === covered) return false;
  // Raw bytes are ~99% tool results, so a full chunk of CONVERSATION needs far more raw growth
  // than CHUNK_CHARS. Gate cheaply on raw growth here; catchUpDigest does the real accounting.
  if (size - covered >= CHUNK_CHARS) return true;
  // Below that, a settled session still needs its short trailing span summarized (see
  // catchUpDigest). The raw floor is loose on purpose — catchUpDigest re-checks against
  // MIN_CHUNK_CHARS of real conversation and no-ops if it doesn't qualify.
  try {
    const st = await stat(transcriptPath);
    return Date.now() - st.mtimeMs > IDLE_SETTLE_MS;
  } catch {
    return false;
  }
}
