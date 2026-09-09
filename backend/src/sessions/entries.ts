// Streaming extraction of a transcript's *conversational* entries — user text, assistant text, and
// tool-use names/paths — discarding tool RESULT bodies. That discard is the whole point: measured
// across this machine's 490 transcripts, tool results are 98-99% of the bytes (a 199 MB session
// holds only ~1.4 MB of conversation), so everything downstream gets three orders of magnitude
// cheaper by never carrying them.
//
// Reads from a byte offset so a caller that has already consumed the first N bytes pays only for
// what was appended since. Transcripts are append-only JSONL, so an offset stays valid; callers
// must still handle the file having SHRUNK (rewritten rather than appended), which invalidates it.
import { NOISE_MESSAGE, firstTextFromContent } from "./shared.ts";

export const ENTRY_MAX_CHARS = 600;

/**
 * Paths that say nothing about which CODE a session owns, and so only mislead routing: this app's
 * own memory/transcript tree under ~/.claude, dependency dirs, dotfiles (.env*), and lockfiles.
 * Worth filtering rather than tolerating because file overlap is the most heavily weighted signal
 * in the routing heuristic — noise here costs more than noise anywhere else.
 */
export function isRoutingRelevantFile(path: string): boolean {
  if (path.includes("/.claude/") || path.includes("/node_modules/") || path.includes("/.git/")) return false;
  // Scratch and temp trees: a session that wrote a throwaway script to /tmp does not "own" it, and
  // these inflate every token's document frequency — which deflates the real IDF of genuine code
  // tokens across the whole candidate set.
  if (/(^|\/)(tmp|private\/tmp|scratchpad|\.cache|Downloads)\//.test(path)) return false;
  const base = path.slice(path.lastIndexOf("/") + 1);
  if (base.startsWith(".")) return false;
  // screenshots/pastes and explicitly-temporary files carry no ownership signal
  if (/\.(png|jpe?g|gif|webp|svg|ico|mp4|mov|zip|pdf)$/i.test(base)) return false;
  if (/\.tmp\.|(^|_)tmp_|\.output$/.test(base)) return false;
  return !/(^|\.)lock(\.json)?$|-lock\.(json|yaml)$/.test(base);
}

export type TranscriptEntry = {
  text: string;
  /** byte offset just past the transcript line this entry came from — a safe resume point */
  endByte: number;
};

export type EntryScan = {
  entries: TranscriptEntry[];
  /** offset past the last COMPLETE line consumed; a trailing partial line is left unconsumed */
  endByte: number;
  /** files touched by Edit/Write/NotebookEdit-style tool_use blocks in this span */
  files: string[];
};

/**
 * Extract entries from `path` starting at `startByte`.
 *
 * Slicing at `startByte` is only safe because every offset this returns sits immediately after a
 * newline, and "\n" is single-byte in UTF-8 — so a slice there can never land mid-codepoint.
 */
export async function scanEntriesFrom(
  path: string,
  startByte = 0,
  /**
   * Set when `startByte` was chosen arbitrarily (e.g. "last N bytes") rather than taken from a
   * previous scan's `endByte`. The first line is then almost certainly a fragment, so it is
   * dropped instead of failing to parse.
   */
  startsMidLine = false
): Promise<EntryScan> {
  const file = Bun.file(path);
  const size = file.size;
  if (startByte >= size) return { entries: [], endByte: startByte, files: [] };

  const buf = Buffer.from(await file.slice(startByte).arrayBuffer());
  const text = buf.toString("utf-8");

  // A transcript is appended to while we read it, so the final line is routinely half-written.
  // Stop at the last newline and leave the remainder for the next call rather than parsing a
  // truncated JSON object (or worse, silently skipping it and advancing past it).
  const lastNl = text.lastIndexOf("\n");
  if (lastNl === -1) return { entries: [], endByte: startByte, files: [] };
  let text2 = text;
  let skipped = 0;
  if (startsMidLine) {
    const firstNl = text.indexOf("\n");
    if (firstNl === -1) return { entries: [], endByte: startByte, files: [] };
    skipped = firstNl + 1;
    text2 = text.slice(skipped);
  }
  const lastNl2 = text2.lastIndexOf("\n");
  if (lastNl2 === -1) return { entries: [], endByte: startByte, files: [] };
  const complete = text2.slice(0, lastNl2 + 1);

  const entries: TranscriptEntry[] = [];
  const files = new Set<string>();
  let cursor = startByte + skipped;

  for (const line of complete.split("\n")) {
    // advance the cursor for EVERY line, parsed or not, so offsets stay true to the file
    const lineBytes = Buffer.byteLength(line, "utf-8") + 1; // +1 for the "\n" split removed
    cursor += lineBytes;
    if (!line) continue;

    let d: any;
    try {
      d = JSON.parse(line);
    } catch {
      continue;
    }

    const push = (t: string) => entries.push({ text: t, endByte: cursor });

    if (d.type === "user" && d.message?.content && !d.isMeta) {
      const trimmed = firstTextFromContent(d.message.content)?.trim();
      if (trimmed && !NOISE_MESSAGE.test(trimmed)) push(`USER: ${trimmed.slice(0, ENTRY_MAX_CHARS)}`);
    } else if (d.type === "assistant" && Array.isArray(d.message?.content)) {
      for (const block of d.message.content) {
        if (block?.type === "text" && block.text?.trim()) {
          push(`ASSISTANT: ${block.text.trim().slice(0, ENTRY_MAX_CHARS)}`);
        } else if (block?.type === "tool_use") {
          const detail = block.input?.file_path || block.input?.command || block.input?.pattern || "";
          push(`ASSISTANT used ${block.name}${detail ? `: ${String(detail).slice(0, 200)}` : ""}`);
          if (block.input?.file_path && isRoutingRelevantFile(block.input.file_path)) files.add(block.input.file_path);
        }
      }
    }
  }

  // cursor counted the empty string after the final "\n"; that split artifact added 1 byte too many
  const endByte = startByte + skipped + Buffer.byteLength(complete, "utf-8");
  return { entries, endByte, files: [...files] };
}
