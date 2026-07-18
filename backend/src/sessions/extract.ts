// Condensed transcript digest, built ourselves (not via an agent Read) since transcripts can run
// several MB. Used by the live Delegations feature; the OTHER caller, routes/contexts.ts (backend
// half of "🧠 Extract"), is currently unused — its only frontend entry point is hidden/disabled,
// see components/modals/extractModal.js.
import { readFile } from "node:fs/promises";
import { NOISE_MESSAGE, firstTextFromContent } from "./shared.ts";

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
