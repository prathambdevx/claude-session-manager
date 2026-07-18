// HTTP-level tests for the paste-image route.
import { test, expect, afterAll } from "bun:test";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleRequest } from "../src/routes/index.ts";

const IMAGES_DIR = join(tmpdir(), "csm-quick-prompt-images");

afterAll(async () => {
  await rm(IMAGES_DIR, { recursive: true, force: true });
});

function post(path: string, body: unknown) {
  return handleRequest(new Request(`http://localhost${path}`, { method: "POST", body: JSON.stringify(body) }));
}

test("POST /api/paste-image writes the file and returns its path", async () => {
  const base64 = Buffer.from("fake png bytes").toString("base64");
  const res = await post("/api/paste-image", { mimeType: "image/png", base64 });
  expect(res.status).toBe(200);
  const data = await res.json();
  expect(data.path).toMatch(/csm-quick-prompt-images\/[\w-]+\.png$/);
  expect(await Bun.file(data.path).text()).toBe("fake png bytes");
});

test("POST /api/paste-image rejects an unsupported mime type", async () => {
  const res = await post("/api/paste-image", { mimeType: "application/pdf", base64: "abc" });
  expect(res.status).toBe(400);
});

test("POST /api/paste-image rejects missing image data", async () => {
  const res = await post("/api/paste-image", { mimeType: "image/png", base64: "" });
  expect(res.status).toBe(400);
});
