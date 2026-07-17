// HTTP-level tests for Quick Prompt's routes, isolated via CSM_DATA_DIR (mirrors routes.test.ts's
// setup). Only exercises the validation/not-found paths — never reaches runClaudeHeadlessDetached,
// so no real `claude` process gets spawned by the test suite.
import { test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

let dir: string;
let handleRequest: typeof import("../src/routes/index.ts").handleRequest;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "csm-quickprompts-test-"));
  process.env.CSM_DATA_DIR = dir;
  ({ handleRequest } = await import("../src/routes/index.ts"));
});

afterAll(async () => {
  delete process.env.CSM_DATA_DIR;
  await rm(dir, { recursive: true, force: true });
});

function post(path: string, body: unknown) {
  return handleRequest(new Request(`http://localhost${path}`, { method: "POST", body: JSON.stringify(body) }));
}
function del(path: string) {
  return handleRequest(new Request(`http://localhost${path}`, { method: "DELETE" }));
}

test("POST /api/quickprompts requires a non-empty prompt", async () => {
  const res = await post("/api/quickprompts", { sessionId: "nope", prompt: "   " });
  expect(res.status).toBe(400);
});

test("POST /api/quickprompts 404s for a session that doesn't exist", async () => {
  const res = await post("/api/quickprompts", { sessionId: "definitely-not-a-real-session-id", prompt: "do something" });
  expect(res.status).toBe(404);
  const data = await res.json();
  expect(data.error).toBe("session not found");
});

test("POST /api/quickprompts/:id/cancel 404s for an unknown job", async () => {
  const res = await post("/api/quickprompts/unknown-job-id/cancel", {});
  expect(res.status).toBe(404);
});

test("DELETE /api/quickprompts/:id is idempotent even if the job never existed", async () => {
  const res = await del("/api/quickprompts/unknown-job-id");
  const data = await res.json();
  expect(data.ok).toBe(true);
});
