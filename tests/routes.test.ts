// HTTP-level tests for the ticket API in src/routes.ts (create/patch/delete), isolated via
// CSM_DATA_DIR so nothing touches this machine's real data/. Only ticket endpoints are exercised
// here — they don't call scanAllSessions, so there's no dependency on real ~/.claude session data.
import { test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

let dir: string;
let handleRequest: typeof import("../src/routes.ts").handleRequest;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "csm-routes-test-"));
  process.env.CSM_DATA_DIR = dir;
  ({ handleRequest } = await import("../src/routes.ts"));
});

afterAll(async () => {
  delete process.env.CSM_DATA_DIR;
  await rm(dir, { recursive: true, force: true });
});

function post(path: string, body: unknown) {
  return handleRequest(new Request(`http://localhost${path}`, { method: "POST", body: JSON.stringify(body) }));
}
function put(path: string, body: unknown) {
  return handleRequest(new Request(`http://localhost${path}`, { method: "PUT", body: JSON.stringify(body) }));
}
function del(path: string) {
  return handleRequest(new Request(`http://localhost${path}`, { method: "DELETE" }));
}

test("POST /api/tickets requires a title", async () => {
  const res = await post("/api/tickets", { notes: "just a task, no title" });
  expect(res.status).toBe(400);
});

test("creates a ticket with its task text stored as notes, and no startedSessionId yet", async () => {
  const res = await post("/api/tickets", { title: "Bugs v1", notes: "fix the flaky test", board: "in-progress" });
  const data = await res.json();
  expect(data.ok).toBe(true);
  expect(data.ticket.title).toBe("Bugs v1");
  expect(data.ticket.notes).toBe("fix the flaky test");
  expect(data.ticket.startedSessionId).toBeUndefined();
});

test("PUT /api/tickets/:id links a launched session — the ticket should now show Resume", async () => {
  const created = await (await post("/api/tickets", { title: "Ticket to start" })).json();
  const id = created.ticket.id;

  const patched = await (await put(`/api/tickets/${id}`, { startedSessionId: "session-123" })).json();
  expect(patched.ok).toBe(true);
  expect(patched.ticket.startedSessionId).toBe("session-123");

  // clearing it back to empty string removes the link (matches routes.ts's `|| undefined` handling)
  const cleared = await (await put(`/api/tickets/${id}`, { startedSessionId: "" })).json();
  expect(cleared.ticket.startedSessionId).toBeUndefined();
});

test("PUT /api/tickets/:id 404s for an unknown id", async () => {
  const res = await put("/api/tickets/does-not-exist", { done: true });
  expect(res.status).toBe(404);
});

test("DELETE /api/tickets/:id removes it", async () => {
  const created = await (await post("/api/tickets", { title: "Throwaway" })).json();
  const id = created.ticket.id;
  const res = await del(`/api/tickets/${id}`);
  expect((await res.json()).ok).toBe(true);
  // deleting again is a harmless no-op, not a 404 (matches routes.ts's unconditional delete + save)
  const second = await del(`/api/tickets/${id}`);
  expect((await second.json()).ok).toBe(true);
});

test("PUT /api/board persists column definitions", async () => {
  const columns = [{ id: "todo", title: "All sessions" }, { id: "in-progress", title: "In Progress" }];
  const res = await handleRequest(
    new Request("http://localhost/api/board", { method: "PUT", body: JSON.stringify({ columns }) })
  );
  const data = await res.json();
  expect(data.ok).toBe(true);
  expect(data.columns).toEqual(columns);
});

test("PUT /api/project-board requires cwd and a columns array", async () => {
  const noCwd = await put("/api/project-board", { columns: [] });
  expect(noCwd.status).toBe(400);

  const noCols = await put("/api/project-board", { cwd: "/x/proj" });
  expect(noCols.status).toBe(400);
});

test("PUT /api/project-board sanitizes columns and keeps each project's board independent", async () => {
  const res = await put("/api/project-board", {
    cwd: "/x/proj-a",
    columns: [{ id: "todo", title: "All sessions" }, { id: "bad" /* missing title, dropped */ }],
  });
  const data = await res.json();
  expect(data.ok).toBe(true);
  expect(data.columns).toEqual([{ id: "todo", title: "All sessions" }]);

  await put("/api/project-board", { cwd: "/x/proj-b", columns: [{ id: "backlog", title: "Backlog" }] });

  // verify on-disk state directly (this file avoids asserting through GET /api/sessions,
  // since that calls scanAllSessions() and would make the test depend on real machine data)
  const { loadProjectBoards } = await import("../src/store.ts");
  const all = await loadProjectBoards();
  expect(all["/x/proj-a"]).toEqual([{ id: "todo", title: "All sessions" }]);
  expect(all["/x/proj-b"]).toEqual([{ id: "backlog", title: "Backlog" }]);
});
