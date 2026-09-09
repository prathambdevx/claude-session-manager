// Covers the two things most likely to break silently in the routing digest layer: resumable byte
// offsets (a wrong offset corrupts every later summary) and the noise filter on tracked files.
import { test, expect } from "bun:test";
import { mkdtemp, writeFile, appendFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { scanEntriesFrom, isRoutingRelevantFile } from "../src/sessions/entries.ts";

function userLine(text: string) {
  return JSON.stringify({ type: "user", message: { role: "user", content: text } }) + "\n";
}
function toolLine(name: string, filePath?: string) {
  return (
    JSON.stringify({
      type: "assistant",
      message: { role: "assistant", content: [{ type: "tool_use", name, input: filePath ? { file_path: filePath } : {} }] },
    }) + "\n"
  );
}

async function fixture(lines: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "csm-digest-"));
  const p = join(dir, "t.jsonl");
  await writeFile(p, lines);
  return p;
}

test("scanEntriesFrom reads all entries from offset 0", async () => {
  const p = await fixture(userLine("first task") + toolLine("Edit", "/repo/src/a.ts") + userLine("second task"));
  const { entries, files } = await scanEntriesFrom(p, 0);
  expect(entries.length).toBe(3);
  expect(entries[0].text).toContain("first task");
  expect(files).toContain("/repo/src/a.ts");
});

test("resuming from a returned offset yields exactly the remaining entries", async () => {
  const p = await fixture(userLine("one") + userLine("two") + userLine("three"));
  const full = await scanEntriesFrom(p, 0);
  expect(full.entries.length).toBe(3);

  const afterFirst = full.entries[0].endByte;
  const rest = await scanEntriesFrom(p, afterFirst);
  expect(rest.entries.length).toBe(2);
  expect(rest.entries[0].text).toContain("two");
  // the resumed scan must agree with the full scan about where the file ends
  expect(rest.endByte).toBe(full.endByte);
});

test("endByte equals file size when the file ends in a newline", async () => {
  const p = await fixture(userLine("a") + userLine("b"));
  const { endByte } = await scanEntriesFrom(p, 0);
  expect(endByte).toBe(Bun.file(p).size);
});

test("a half-written trailing line is left unconsumed until complete", async () => {
  const p = await fixture(userLine("complete"));
  await appendFile(p, '{"type":"user","message":{"role":"user","content":"partial');
  const first = await scanEntriesFrom(p, 0);
  // the partial line must not be parsed, and the offset must not advance past it
  expect(first.entries.length).toBe(1);
  expect(first.endByte).toBeLessThan(Bun.file(p).size);

  // once the line is finished, resuming from that offset picks it up
  await appendFile(p, '"}}\n');
  const second = await scanEntriesFrom(p, first.endByte);
  expect(second.entries.length).toBe(1);
  expect(second.entries[0].text).toContain("partial");
});

test("scanning past the end is a no-op, not an error", async () => {
  const p = await fixture(userLine("only"));
  const size = Bun.file(p).size;
  const { entries, endByte } = await scanEntriesFrom(p, size);
  expect(entries.length).toBe(0);
  expect(endByte).toBe(size);
});

test("multibyte content does not corrupt offsets", async () => {
  const p = await fixture(userLine("café ✅ 日本語") + userLine("after"));
  const full = await scanEntriesFrom(p, 0);
  expect(full.entries.length).toBe(2);
  const rest = await scanEntriesFrom(p, full.entries[0].endByte);
  expect(rest.entries.length).toBe(1);
  expect(rest.entries[0].text).toContain("after");
});

test("noise paths are excluded from routing-relevant files", () => {
  // these carry no signal about which code a session owns, and file overlap is the most heavily
  // weighted term in the routing heuristic — so they mislead more than they help
  expect(isRoutingRelevantFile("/Users/x/.claude/projects/p/memory/ref.md")).toBe(false);
  expect(isRoutingRelevantFile("/repo/apps/web/.env.local")).toBe(false);
  expect(isRoutingRelevantFile("/repo/node_modules/pkg/index.js")).toBe(false);
  expect(isRoutingRelevantFile("/repo/bun.lock")).toBe(false);
  expect(isRoutingRelevantFile("/repo/package-lock.json")).toBe(false);

  expect(isRoutingRelevantFile("/repo/apps/bff/src/services/otp/index.ts")).toBe(true);
  expect(isRoutingRelevantFile("/repo/docs/security.md")).toBe(true);
});

test("tool_use file paths are filtered at collection time", async () => {
  const p = await fixture(
    toolLine("Edit", "/repo/src/real.ts") +
      toolLine("Edit", "/Users/x/.claude/projects/p/memory/note.md") +
      toolLine("Write", "/repo/apps/web/.env.local")
  );
  const { files } = await scanEntriesFrom(p, 0);
  expect(files).toEqual(["/repo/src/real.ts"]);
});
