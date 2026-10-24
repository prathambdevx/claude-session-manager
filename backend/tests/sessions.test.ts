// Unit tests for transcript reading (src/sessions/). scanTranscript takes an explicit file path, so
// these write throwaway .jsonl fixtures under a temp dir — never touch real ~/.claude data.
import { test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scanTranscript, readTranscriptDetails } from "../src/sessions/index.ts";
import { scanLines, readTail } from "../src/sessions/lineReader.ts";
import { mapLimit } from "../src/concurrency.ts";
import { noteRequest, releaseIfIdle, IDLE_RELEASE_MS } from "../src/polling/idleRelease.ts";

let dir: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "csm-sessions-test-"));
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

function line(obj: unknown): string {
  return JSON.stringify(obj) + "\n";
}

async function writeTranscript(name: string, lines: string[]): Promise<string> {
  const path = join(dir, name);
  await writeFile(path, lines.join(""));
  return path;
}

test("extracts firstMessage from the first real user turn, skipping noise", async () => {
  const path = await writeTranscript("normal.jsonl", [
    line({ type: "user", isMeta: true, message: { content: "<system-reminder>ignore me</system-reminder>" } }),
    line({ type: "user", message: { content: "Fix the bouncing scroll on mobile" } }),
    line({ type: "assistant", message: { content: [{ type: "text", text: "Sure, looking into it." }] } }),
  ]);
  const session = (await scanTranscript(path, "abc123", "-Users-me-project"))!;
  expect(session.firstMessage).toBe("Fix the bouncing scroll on mobile");
  expect(session.id).toBe("abc123");
});

test("picks up cwd/gitBranch from the head; changed files come from the on-demand details read", async () => {
  const path = await writeTranscript("edits.jsonl", [
    line({ type: "user", cwd: "/Users/me/real-project", gitBranch: "feature/x", message: { content: "do the thing" } }),
    line({
      type: "assistant",
      message: {
        content: [
          { type: "tool_use", name: "Edit", input: { file_path: "/Users/me/real-project/src/a.ts" } },
          { type: "tool_use", name: "Read", input: { file_path: "/Users/me/real-project/src/b.ts" } },
          { type: "tool_use", name: "Write", input: { file_path: "/Users/me/real-project/src/c.ts" } },
        ],
      },
    }),
  ]);
  const session = (await scanTranscript(path, "edit1", "-Users-me-real-project"))!;
  expect(session.cwd).toBe("/Users/me/real-project");
  expect(session.gitBranch).toBe("feature/x");
  expect((await readTranscriptDetails(path)).changedFiles.sort()).toEqual(["/Users/me/real-project/src/a.ts", "/Users/me/real-project/src/c.ts"]);
});

test("a stub with no user/assistant turn is not listed", async () => {
  const path = await writeTranscript("stub.jsonl", [line({ type: "system", subtype: "local_command", cwd: "/Users/me/x" })]);
  expect(await scanTranscript(path, "stub1", "-Users-me-x")).toBeNull();
});

test("the auto-summary sample keeps the first 4 and last 4 user messages", async () => {
  const msgs = Array.from({ length: 11 }, (_, i) => line({ type: "user", message: { content: `msg ${i}` } }));
  const details = await readTranscriptDetails(await writeTranscript("many.jsonl", msgs));
  expect(details.userMessageSample).toEqual(["msg 0", "msg 1", "msg 2", "msg 3", "(…conversation continues…)", "msg 7", "msg 8", "msg 9", "msg 10"]);
  const few = await readTranscriptDetails(await writeTranscript("few.jsonl", msgs.slice(0, 8)));
  expect(few.userMessageSample).toEqual(Array.from({ length: 8 }, (_, i) => `msg ${i}`));
});

test("scanLines joins lines split across chunks and returns an unterminated tail as partial", async () => {
  const long = "x".repeat(50);
  const path = await writeTranscript("chunks.jsonl", [`a${long}\n`, `b${long}\n`, "tail-no-newline"]);
  const lines: string[] = [];
  const res = await scanLines(path, (l) => { lines.push(l); }, { chunkBytes: 16 });
  expect(lines).toEqual([`a${long}`, `b${long}`]);
  expect(res.partial).toBe("tail-no-newline");
  expect(await readTail(path, 30)).toBe("tail-no-newline"); // starts after a line break, not mid-line
});

test("scanLines stops at maxBytes, so a head read never walks a whole huge file", async () => {
  const path = await writeTranscript("big.jsonl", Array.from({ length: 1000 }, () => "y".repeat(99) + "\n"));
  let count = 0;
  const res = await scanLines(path, () => { count++; }, { chunkBytes: 1000, maxBytes: 5000 });
  expect(res.stopped).toBe(true);
  expect(count).toBe(50);
});

test("mapLimit never runs more than the limit at once and keeps result order", async () => {
  let active = 0;
  let peak = 0;
  const out = await mapLimit([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 4, async (n) => {
    active++;
    peak = Math.max(peak, active);
    await new Promise((r) => setTimeout(r, 5));
    active--;
    return n * 2;
  });
  expect(peak).toBe(4);
  expect(out).toEqual([2, 4, 6, 8, 10, 12, 14, 16, 18, 20]);
});

test("idle release fires once after 30 idle minutes and clears the head cache", async () => {
  const path = await writeTranscript("idle.jsonl", [line({ type: "user", cwd: "/Users/me/p", message: { content: "first A" } })]);
  expect((await scanTranscript(path, "idle1", "-Users-me-p"))!.firstMessage).toBe("first A");
  await writeFile(path, line({ type: "user", cwd: "/Users/me/p", message: { content: "first B" } }));
  expect((await scanTranscript(path, "idle1", "-Users-me-p"))!.firstMessage).toBe("first A"); // cached head

  noteRequest(new Request("http://x/api/board"), new URL("http://x/api/board"));
  const t0 = Date.now();
  expect(releaseIfIdle(t0 + 60_000)).toBe(false);
  // the board's background poll and the SSE stream don't count as user activity
  noteRequest(new Request("http://x/api/sessions"), new URL("http://x/api/sessions"));
  noteRequest(new Request("http://x/api/events"), new URL("http://x/api/events"));
  expect(releaseIfIdle(t0 + IDLE_RELEASE_MS + 1000)).toBe(true);
  expect(releaseIfIdle(t0 + IDLE_RELEASE_MS + 2000)).toBe(false); // once per idle period
  expect((await scanTranscript(path, "idle1", "-Users-me-p"))!.firstMessage).toBe("first B");
});
