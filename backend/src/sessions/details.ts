// Content of ONE transcript, read on demand (auto-summary, delegation) and streamed — the session
// list itself never reads transcript bodies beyond a small head (see index.ts).
import { NOISE_MESSAGE, firstTextFromContent } from "./shared.ts";
import { scanLines } from "./lineReader.ts";
import { SAMPLE_GAP_MARKER } from "./autoSummary.ts";

const WRITE_TOOLS = new Set(["Edit", "Write", "NotebookEdit"]);
const SAMPLE_HEAD = 4;
const SAMPLE_TAIL = 4;
const SAMPLE_KEEP_ALL = SAMPLE_HEAD + SAMPLE_TAIL;

export type TranscriptDetails = {
  userMessageSample: string[];
  changedFiles: string[];
};

export async function readTranscriptDetails(path: string): Promise<TranscriptDetails> {
  const head: string[] = [];
  const tail: string[] = [];
  let userCount = 0;
  const changed = new Set<string>();
  const onLine = (line: string) => {
    let d: any;
    try {
      d = JSON.parse(line);
    } catch {
      return;
    }
    if (d.type === "user" && d.message?.content && !d.isMeta) {
      const trimmed = firstTextFromContent(d.message.content)?.trim();
      if (trimmed && !NOISE_MESSAGE.test(trimmed)) {
        const m = trimmed.slice(0, 400);
        userCount++;
        if (userCount <= SAMPLE_KEEP_ALL) head.push(m);
        else if (head.length > SAMPLE_HEAD) head.length = SAMPLE_HEAD;
        tail.push(m);
        if (tail.length > SAMPLE_TAIL) tail.shift();
      }
    }
    if (d.type === "assistant" && Array.isArray(d.message?.content)) {
      for (const block of d.message.content) {
        if (block?.type === "tool_use" && WRITE_TOOLS.has(block.name) && typeof block.input?.file_path === "string") {
          changed.add(block.input.file_path);
        }
      }
    }
  };
  const { partial } = await scanLines(path, onLine);
  if (partial) onLine(partial);
  // Same head+tail sample as sampleUserMessages over every message, without keeping every message.
  return {
    userMessageSample: userCount <= SAMPLE_KEEP_ALL ? head : [...head, SAMPLE_GAP_MARKER, ...tail],
    changedFiles: [...changed],
  };
}
