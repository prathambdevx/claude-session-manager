// Exercises GridManager entirely against an in-memory fake TmuxRunner — no real tmux process is
// ever spawned, per docs/spec/2026-07-21-tmux-terminal-architecture.md §14.
import { describe, test, expect, beforeEach } from "bun:test";
import { GridManager } from "../src/claude/tmux/grids.ts";
import type { TmuxRunner, PaneInfo } from "../src/claude/tmux/tmux.ts";

type FakePane = { session: string; paneId: string; sid: string | null; pid: number; title: string | null };

class FakeTmux implements TmuxRunner {
  panes: FakePane[] = [];
  attachedSessions = new Set<string>();
  private nextPaneId = 0;
  private nextPid = 1000;

  private newPane(session: string): string {
    const paneId = `%${this.nextPaneId++}`;
    this.panes.push({ session, paneId, sid: null, pid: this.nextPid++, title: null });
    return paneId;
  }

  hasSession(session: string): boolean {
    return this.panes.some((p) => p.session === session);
  }
  newSession(session: string): string | null {
    return this.newPane(session);
  }
  splitWindow(session: string): string | null {
    if (!this.hasSession(session)) return null;
    return this.newPane(session);
  }
  killPane(paneId: string): boolean {
    const before = this.panes.length;
    this.panes = this.panes.filter((p) => p.paneId !== paneId);
    return this.panes.length < before;
  }
  killSession(session: string): boolean {
    const before = this.panes.length;
    this.panes = this.panes.filter((p) => p.session !== session);
    return this.panes.length < before;
  }
  isolatePane(paneId: string, newSession: string): boolean {
    const pane = this.panes.find((p) => p.paneId === paneId);
    if (!pane) return false;
    pane.session = newSession;
    return true;
  }
  sendKeys(): boolean {
    return true;
  }
  selectLayout(): boolean {
    return true;
  }
  selectPane(): boolean {
    return true;
  }
  setPaneOption(paneId: string, key: string, value: string): boolean {
    const pane = this.panes.find((p) => p.paneId === paneId);
    if (!pane) return false;
    if (key === "@csm_sid") pane.sid = value;
    return true;
  }
  setSessionStatusOff(): void {}
  setPaneTitle(paneId: string, title: string): boolean {
    const pane = this.panes.find((p) => p.paneId === paneId);
    if (!pane) return false;
    pane.title = title;
    return true;
  }
  setPaneBorderStatus(): boolean {
    return true;
  }
  renameSession(): boolean {
    return true;
  }
  listClients(): Set<string> {
    return new Set(this.attachedSessions);
  }
  listPanesAll(): PaneInfo[] {
    return this.panes
      .filter((p) => p.session.startsWith("csm-grid-"))
      .map((p) => ({
        session: p.session,
        paneId: p.paneId,
        sid: p.sid,
        pid: p.pid,
        attached: this.attachedSessions.has(p.session),
      }));
  }
}

let fake: FakeTmux;
let grids: GridManager;

beforeEach(() => {
  fake = new FakeTmux();
  grids = new GridManager(fake);
});

describe("GridManager mapping and reconciliation", () => {
  test("openOrCreate starts a new grid and maps the sid to its pane", () => {
    const opened = grids.openOrCreate("sid-1", ["echo", "hi"]);
    expect(opened?.created).toBe(true);
    const pane = grids.resolvePane("sid-1");
    expect(pane?.paneId).toBe(opened?.paneId);
    expect(pane?.gridId).toBe(opened?.gridId);
  });

  test("openOrCreate reuses the existing pane for an already-mapped sid", () => {
    const first = grids.openOrCreate("sid-1", ["echo", "hi"]);
    const second = grids.openOrCreate("sid-1", ["echo", "hi"]);
    expect(second?.created).toBe(false);
    expect(second?.paneId).toBe(first?.paneId);
    expect(fake.panes.length).toBe(1);
  });

  test("ownership guard: an untagged pane in a csm-grid session is never mapped", () => {
    grids.openOrCreate("sid-1", ["echo"]);
    // simulate the user manually splitting the pane themselves, outside the app
    const grid = grids.listGrids()[0];
    fake.splitWindow(grid.session);
    grids.reconcile();
    expect(grids.listGrids()[0].panes.length).toBe(1); // the untagged split is not counted
  });

  test("ownership guard: a foreign (non csm-grid-*) session is never touched", () => {
    fake.panes.push({ session: "some-other-session", paneId: "%99", sid: "sid-x", pid: 42 });
    grids.reconcile();
    expect(grids.resolvePane("sid-x")).toBeNull();
    expect(grids.listGrids().length).toBe(0);
  });
});

describe("Auto-tiling ladder", () => {
  test("2nd session in the same attached grid selects even-horizontal", () => {
    grids.openOrCreate("sid-1", ["echo"]);
    fake.attachedSessions.add(grids.listGrids()[0].session);
    let seenLayout: string | null = null;
    fake.selectLayout = (session, layout) => {
      seenLayout = layout;
      return true;
    };
    grids.openOrCreate("sid-2", ["echo"]);
    expect(seenLayout).toBe("even-horizontal");
  });

  test("3rd session selects main-vertical, 4th selects tiled", () => {
    grids.openOrCreate("sid-1", ["echo"]);
    fake.attachedSessions.add(grids.listGrids()[0].session);
    const layouts: string[] = [];
    fake.selectLayout = (session, layout) => {
      layouts.push(layout);
      return true;
    };
    grids.openOrCreate("sid-2", ["echo"]);
    grids.openOrCreate("sid-3", ["echo"]);
    grids.openOrCreate("sid-4", ["echo"]);
    expect(layouts).toEqual(["even-horizontal", "main-vertical", "tiled"]);
  });

  test("a 5th session spills into a new grid once the active one has 4 panes", () => {
    grids.openOrCreate("sid-1", ["echo"]);
    fake.attachedSessions.add(grids.listGrids()[0].session);
    grids.openOrCreate("sid-2", ["echo"]);
    grids.openOrCreate("sid-3", ["echo"]);
    const full = grids.openOrCreate("sid-4", ["echo"]);
    const spilled = grids.openOrCreate("sid-5", ["echo"]);
    expect(spilled?.gridId).not.toBe(full?.gridId);
    expect(grids.listGrids().length).toBe(2);
  });
});

describe("Fork-pending and /clear remap", () => {
  test("openForkPending tags a pending sentinel immediately, resolveForkSid retags it", () => {
    const pending = grids.openForkPending(["echo"]);
    expect(pending?.pendingSid.startsWith("pending:")).toBe(true);
    grids.reconcile(); // a fresh poll against live tmux excludes any still-pending sid from the index
    expect(grids.resolvePane(pending!.pendingSid)).toBeNull();
    grids.resolveForkSid(pending!.paneId, "real-sid");
    expect(grids.resolvePane("real-sid")?.paneId).toBe(pending?.paneId);
  });

  test("remapSid retags a live pane from its pre-clear sid to the new one", () => {
    const opened = grids.openOrCreate("old-sid", ["echo"]);
    const ok = grids.remapSid("old-sid", "new-sid");
    expect(ok).toBe(true);
    expect(grids.resolvePane("old-sid")).toBeNull();
    expect(grids.resolvePane("new-sid")?.paneId).toBe(opened?.paneId);
  });

  test("remapSid returns false when the old sid has no live pane", () => {
    expect(grids.remapSid("never-existed", "new-sid")).toBe(false);
  });
});

describe("Attached/dot derivation", () => {
  test("isAttached is false until a client attaches to the grid's session", () => {
    grids.openOrCreate("sid-1", ["echo"]);
    expect(grids.isAttached("sid-1")).toBe(false);
    fake.attachedSessions.add(grids.listGrids()[0].session);
    grids.reconcile();
    expect(grids.isAttached("sid-1")).toBe(true);
  });

  test("isAttached is false for an sid with no live pane", () => {
    expect(grids.isAttached("nope")).toBe(false);
  });
});

describe("closeSession / empty-grid cleanup", () => {
  test("closing the only pane in a grid kills the whole session", () => {
    grids.openOrCreate("sid-1", ["echo"]);
    const session = grids.listGrids()[0].session;
    let killedSession: string | null = null;
    fake.killSession = (s) => {
      killedSession = s;
      return true;
    };
    expect(grids.closeSession("sid-1")).toBe(true);
    expect(killedSession).toBe(session);
  });

  test("closing one of several panes re-tiles the survivors instead of killing the grid", () => {
    grids.openOrCreate("sid-1", ["echo"]);
    fake.attachedSessions.add(grids.listGrids()[0].session);
    grids.openOrCreate("sid-2", ["echo"]);
    let killedSession: string | null = null;
    fake.killSession = (s) => {
      killedSession = s;
      return true;
    };
    expect(grids.closeSession("sid-1")).toBe(true);
    expect(killedSession).toBeNull();
    expect(grids.resolvePane("sid-2")).not.toBeNull();
  });

  test("closeSession returns false for an sid with no live pane", () => {
    expect(grids.closeSession("nope")).toBe(false);
  });
});

describe("resolveForResume / BUG A — stale detached multi-pane grids", () => {
  test("reopening a pane in a detached grid with siblings isolates it into its own fresh grid", () => {
    grids.openOrCreate("sid-1", ["echo"]);
    const session = grids.listGrids()[0].session;
    fake.attachedSessions.add(session);
    grids.openOrCreate("sid-2", ["echo"]);
    grids.openOrCreate("sid-3", ["echo"]);
    // simulate the terminal window closing (client detaches) while all panes stay alive
    fake.attachedSessions.delete(session);
    grids.reconcile();

    const resumed = grids.resolveForResume("sid-2");
    expect(resumed?.attached).toBe(false);
    expect(resumed?.gridId).not.toBe(grids.resolvePane("sid-1")?.gridId);
    expect(resumed?.gridId).not.toBe(grids.resolvePane("sid-3")?.gridId);
    // the sibling panes stay behind in the old grid instead of resurfacing with sid-2
    expect(grids.listGrids().find((g) => g.gridId === resumed?.gridId)?.panes.length).toBe(1);
    expect(grids.listGrids().find((g) => g.gridId === grids.resolvePane("sid-1")?.gridId)?.panes.length).toBe(2);
  });

  test("reopening a pane in an attached grid is left in place (still-visible siblings are intentional tiling)", () => {
    grids.openOrCreate("sid-1", ["echo"]);
    const session = grids.listGrids()[0].session;
    fake.attachedSessions.add(session);
    grids.openOrCreate("sid-2", ["echo"]);

    const resumed = grids.resolveForResume("sid-2");
    expect(resumed?.attached).toBe(true);
    expect(resumed?.gridId).toBe(grids.resolvePane("sid-1")?.gridId);
  });

  test("reopening the sole pane of a detached grid needs no isolation", () => {
    const opened = grids.openOrCreate("sid-1", ["echo"]);
    const resumed = grids.resolveForResume("sid-1");
    expect(resumed?.gridId).toBe(opened?.gridId);
    expect(resumed?.attached).toBe(false);
  });

  test("resolveForResume returns null for an sid with no live pane", () => {
    expect(grids.resolveForResume("nope")).toBeNull();
  });
});

describe("pane title/label seeded at creation", () => {
  test("openOrCreate's new-grid path sets the pane title from the label argument", () => {
    grids.openOrCreate("sid-1", ["echo"], undefined, "My Session");
    expect(fake.panes[0].title).toBe("My Session");
  });

  test("openOrCreate's split-into-existing path also sets the pane title from the label argument", () => {
    grids.openOrCreate("sid-1", ["echo"], undefined, "First");
    fake.attachedSessions.add(grids.listGrids()[0].session);
    grids.openOrCreate("sid-2", ["echo"], undefined, "Second");
    expect(fake.panes[1].title).toBe("Second");
  });

  test("openStandalone and openForkPending also seed the pane title from the label argument", () => {
    grids.openStandalone("sid-1", ["echo"], undefined, "Standalone");
    expect(fake.panes[0].title).toBe("Standalone");
    grids.openForkPending(["echo"], undefined, "Forked");
    expect(fake.panes[1].title).toBe("Forked");
  });
});

describe("reconcile attach-transition diffing (M2)", () => {
  test("reports both attach and detach transitions for sids whose panes survive", () => {
    grids.openOrCreate("sid-1", ["echo"]);
    const session = grids.listGrids()[0].session;

    fake.attachedSessions.add(session);
    let { attachChanged } = grids.reconcile();
    expect(attachChanged).toEqual([{ sid: "sid-1", attached: true }]);

    fake.attachedSessions.delete(session);
    ({ attachChanged } = grids.reconcile());
    expect(attachChanged).toEqual([{ sid: "sid-1", attached: false }]);

    // no change on this tick — nothing should be reported
    ({ attachChanged } = grids.reconcile());
    expect(attachChanged).toEqual([]);
  });
});
