// Unit tests for transcript scanning (src/sessions.ts). scanTranscript takes an explicit file
// path, so these write throwaway .jsonl fixtures under a temp dir — never touch real ~/.claude data.
import { test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scanTranscript } from "../src/sessions/index.ts";
import { CONTEXT_WINDOW_TOKENS } from "../src/config.ts";

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
  const session = await scanTranscript(path, "abc123", "-Users-me-project");
  expect(session.firstMessage).toBe("Fix the bouncing scroll on mobile");
  expect(session.id).toBe("abc123");
});

test("computes contextPct from the last assistant usage entry", async () => {
  const path = await writeTranscript("context.jsonl", [
    line({ type: "user", message: { content: "hello" } }),
    line({
      type: "assistant",
      message: { content: [{ type: "text", text: "hi" }], usage: { input_tokens: 1000, cache_read_input_tokens: 0 } },
    }),
    line({
      type: "assistant",
      message: { content: [{ type: "text", text: "more" }], usage: { input_tokens: 50000, cache_read_input_tokens: 30000 } },
    }),
  ]);
  const session = await scanTranscript(path, "ctx1", "-Users-me-project");
  // last usage wins: 50000 + 30000 = 80000, regardless of which context window this machine uses
  expect(session.contextTokens).toBe(80000);
  expect(session.contextPct).toBe(Math.min(100, Math.round((80000 / CONTEXT_WINDOW_TOKENS) * 100)));
});

test("a turn using more than 200K tokens proves extended context — window becomes 1M regardless of the global setting", async () => {
  const path = await writeTranscript("extended-context.jsonl", [
    line({ type: "user", message: { content: "hello" } }),
    line({
      type: "assistant",
      message: { content: [{ type: "text", text: "big turn" }], usage: { input_tokens: 5000, cache_read_input_tokens: 250000 } },
    }),
  ]);
  const session = await scanTranscript(path, "ctx-extended", "-Users-me-project");
  expect(session.contextTokens).toBe(255000);
  expect(session.contextWindow).toBe(1_000_000);
  expect(session.contextPct).toBe(Math.round((255000 / 1_000_000) * 100));
});

test("a mid-session model switch to extended context updates the window from the point of proof onward", async () => {
  const path = await writeTranscript("model-switch.jsonl", [
    line({ type: "user", message: { content: "hello" } }),
    line({
      type: "assistant",
      message: { content: [{ type: "text", text: "small turn" }], usage: { input_tokens: 1000, cache_read_input_tokens: 0 } },
    }),
    line({
      type: "assistant",
      message: { content: [{ type: "text", text: "switched to 1M model" }], usage: { input_tokens: 3000, cache_read_input_tokens: 300000 } },
    }),
  ]);
  const session = await scanTranscript(path, "ctx-switch", "-Users-me-project");
  // last usage wins (303000), and it alone proves this session is now on an extended window
  expect(session.contextTokens).toBe(303000);
  expect(session.contextWindow).toBe(1_000_000);
});

test("contextPct is null (not 0) when no assistant turn has run yet — the post-/clear state", async () => {
  const path = await writeTranscript("fresh-clear.jsonl", [
    line({ type: "user", isMeta: true, message: { content: "<local-command-caveat>Caveat: ...</local-command-caveat>" } }),
    line({ type: "user", isMeta: true, message: { content: "<command-name>/clear</command-name>" } }),
    line({ type: "system", subtype: "local_command" }),
  ]);
  const session = await scanTranscript(path, "cleared1", "-Users-me-project");
  expect(session.contextTokens).toBeNull();
  expect(session.contextPct).toBeNull();
  expect(session.firstMessage).toBeNull();
});

test("tracks files touched by write tools and picks up gitBranch/cwd", async () => {
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
  const session = await scanTranscript(path, "edit1", "-Users-me-real-project");
  expect(session.cwd).toBe("/Users/me/real-project");
  expect(session.gitBranch).toBe("feature/x");
  expect(session.changedFiles.sort()).toEqual(["/Users/me/real-project/src/a.ts", "/Users/me/real-project/src/c.ts"]);
});
