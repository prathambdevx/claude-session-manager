// Chunked line reading for JSONL transcripts — a transcript can be hundreds of MB, so it is never
// read whole: memory per file is one chunk plus the longest single line.
import { open } from "node:fs/promises";

const NEWLINE = 10;

export type LineScanResult = {
  stopped: boolean; // onLine returned false, or maxBytes was reached
  partial: string | null; // trailing bytes with no newline yet (only when the whole file was read)
};

// Calls onLine for every newline-terminated line; returning false stops early. maxBytes caps how far
// it reads, so a head-only read of a huge transcript stays small.
export async function scanLines(
  path: string,
  onLine: (line: string) => boolean | void,
  opts: { chunkBytes?: number; maxBytes?: number } = {}
): Promise<LineScanResult> {
  const chunkBytes = opts.chunkBytes ?? 1 << 20;
  const maxBytes = opts.maxBytes ?? Infinity;
  const fh = await open(path, "r");
  try {
    const buf = Buffer.allocUnsafe(chunkBytes);
    let pos = 0;
    let carry: Buffer[] = [];
    for (;;) {
      if (pos >= maxBytes) return { stopped: true, partial: null };
      const { bytesRead } = await fh.read(buf, 0, chunkBytes, pos);
      if (bytesRead === 0) break;
      const chunk = buf.subarray(0, bytesRead);
      let lineStart = 0;
      for (let nl = chunk.indexOf(NEWLINE); nl !== -1; nl = chunk.indexOf(NEWLINE, lineStart)) {
        const piece = chunk.subarray(lineStart, nl);
        const bytes = carry.length ? Buffer.concat([...carry, piece]) : piece;
        carry = [];
        lineStart = nl + 1;
        if (onLine(bytes.toString("utf8")) === false) return { stopped: true, partial: null };
      }
      // copied, since buf is reused for the next chunk
      if (lineStart < bytesRead) carry.push(Buffer.from(chunk.subarray(lineStart)));
      pos += bytesRead;
    }
    return { stopped: false, partial: carry.length ? Buffer.concat(carry).toString("utf8") : null };
  } finally {
    await fh.close();
  }
}

// The last `bytes` of a file as text, starting at a line boundary — enough to find the latest entries.
export async function readTail(path: string, bytes: number): Promise<string> {
  const fh = await open(path, "r");
  try {
    const { size } = await fh.stat();
    const start = Math.max(0, size - bytes);
    const buf = Buffer.alloc(size - start);
    await fh.read(buf, 0, buf.length, start);
    const text = buf.toString("utf8");
    return start === 0 ? text : text.slice(text.indexOf("\n") + 1);
  } finally {
    await fh.close();
  }
}
