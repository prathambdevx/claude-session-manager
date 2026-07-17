// Tests for src/store.ts persistence: ticket CRUD, board columns, and the /clear-continuity fix
// (reconcileClearedSessions). CSM_DATA_DIR is pointed at a throwaway temp dir BEFORE store.ts is
// imported, so nothing here ever touches this machine's real data/ folder.
import { test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

let dir: string;
let store: typeof import("../src/store.ts");

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "csm-store-test-"));
  process.env.CSM_DATA_DIR = dir;
  store = await import("../src/store.ts");
});

afterAll(async () => {
  delete process.env.CSM_DATA_DIR;
  await rm(dir, { recursive: true, force: true });
});

test("tickets round-trip through save/load, including startedSessionId", async () => {
  const tickets = await store.loadTickets();
  expect(tickets).toEqual({});

  const ticket: import("../src/store.ts").Ticket = {
    id: "t1",
    title: "Fix the header",
    notes: "the task text",
    board: "in-progress",
    createdAt: 1000,
  };
  await store.saveTickets({ t1: ticket });
  let reloaded = await store.loadTickets();
  expect(reloaded.t1.title).toBe("Fix the header");
  expect(reloaded.t1.startedSessionId).toBeUndefined();

  // simulate "Start session" linking the ticket to a launched session (ticket stays, shows Resume)
  reloaded.t1.startedSessionId = "session-abc";
  await store.saveTickets(reloaded);
  reloaded = await store.loadTickets();
  expect(reloaded.t1.startedSessionId).toBe("session-abc");
});

test("board columns default to null before the first save, then persist", async () => {
  expect(await store.loadBoard()).toBeNull(); // no board.json written yet in this temp data dir

  const columns = [{ id: "todo", title: "All sessions" }, { id: "done", title: "Done" }];
  await store.saveBoard(columns);
  expect(await store.loadBoard()).toEqual(columns);
});

test("project boards default to an empty map, then persist independently per cwd", async () => {
  expect(await store.loadProjectBoards()).toEqual({});

  const cols = [{ id: "todo", title: "All sessions" }, { id: "done", title: "Done" }];
  await store.saveProjectBoards({ "/Users/x/proj-a": cols });
  expect(await store.loadProjectBoards()).toEqual({ "/Users/x/proj-a": cols });

  // a second project's columns don't clobber the first — keyed independently
  const cols2 = [{ id: "backlog", title: "Backlog" }];
  const all = await store.loadProjectBoards();
  all["/Users/x/proj-b"] = cols2;
  await store.saveProjectBoards(all);
  const reloaded = await store.loadProjectBoards();
  expect(reloaded["/Users/x/proj-a"]).toEqual(cols);
  expect(reloaded["/Users/x/proj-b"]).toEqual(cols2);
});

test("reconcileClearedSessions carries a running session's name/board to its new post-/clear id", async () => {
  const meta: Record<string, import("../src/store.ts").Meta> = {
    "old-session-id": { name: "Bugs v1", board: "in-progress", pinned: true },
  };
  // first poll: pid 111 is running as "old-session-id"
  const first = await store.reconcileClearedSessions({ "old-session-id": { pid: 111 } }, meta);
  expect(first.changed).toBe(false); // nothing to reconcile yet — this is the first time we've seen this pid
  expect(first.meta["old-session-id"]).toEqual(meta["old-session-id"]);

  // /clear fires: same pid 111, brand-new session id, no meta for it yet
  const second = await store.reconcileClearedSessions({ "new-session-id": { pid: 111 } }, first.meta);
  expect(second.changed).toBe(true);
  // new id inherits the identity + board slot
  expect(second.meta["new-session-id"]).toEqual({ name: "Bugs v1", board: "in-progress", pinned: true });
  // old id is relabeled and dropped out of its board column (falls back to "All sessions")
  expect(second.meta["old-session-id"].name).toBe("Bugs v1 (before clear)");
  expect(second.meta["old-session-id"].board).toBeUndefined();
});

test("reconcileClearedSessions is idempotent — polling again with the same pid->session mapping changes nothing", async () => {
  const meta: Record<string, import("../src/store.ts").Meta> = {
    s1: { name: "Steady session", board: "done" },
  };
  const first = await store.reconcileClearedSessions({ s1: { pid: 222 } }, meta);
  expect(first.changed).toBe(false);
  const second = await store.reconcileClearedSessions({ s1: { pid: 222 } }, first.meta);
  expect(second.changed).toBe(false);
  expect(second.meta.s1).toEqual({ name: "Steady session", board: "done" });
});

test("reconcileClearedSessions does nothing for an unnamed/untracked old session", async () => {
  // no meta entry at all for the old id — nothing worth carrying over
  const seed = await store.reconcileClearedSessions({ "id-a": { pid: 333 } }, {});
  const result = await store.reconcileClearedSessions({ "id-b": { pid: 333 } }, seed.meta);
  expect(result.changed).toBe(false);
  expect(result.meta["id-b"]).toBeUndefined();
});
