// Grid/pane bookkeeping on top of tmux.ts. tmux itself is the source of truth — every public method
// here reconciles against a fresh `list-panes -a`/`list-clients` first, so app memory can never
// drift from what's actually running. data/tmux-state.json (written best-effort after each
// reconcile) is only a warm-start debugging aid, never read back for correctness.
import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { TMUX_STATE_PATH } from "../../constants.ts";
import { realTmux } from "./tmux.ts";
import type { TmuxRunner, PaneInfo } from "./tmux.ts";

// Sentinel prefix for a fork pane whose real sid isn't known yet (discovered later via pid-links,
// same mechanism as /clear) — tagging it immediately still satisfies the ownership guard (it has
// SOME @csm_sid, so it's never mistaken for a pane the user opened manually outside the app).
const PENDING_PREFIX = "pending:";

export type GridId = string;
export type PaneEntry = { paneId: string; sid: string }; // sid may be a PENDING_PREFIX sentinel
export type Grid = { gridId: GridId; session: string; panes: PaneEntry[]; attached: boolean };

const MAX_PANES_PER_GRID = 4;

function layoutForCount(n: number): string | null {
  if (n <= 1) return null; // a single pane needs no tiling
  if (n === 2) return "even-horizontal";
  if (n === 3) return "main-vertical";
  return "tiled";
}

function gridIdFromSession(session: string): GridId | null {
  const m = session.match(/^csm-grid-(.+)$/);
  return m ? m[1] : null;
}

export class GridManager {
  private tmux: TmuxRunner;
  private grids = new Map<GridId, Grid>();
  private sidToPane = new Map<string, { gridId: GridId; paneId: string }>();
  private activeGridId: GridId | null = null;
  private lastAttached = new Map<string, boolean>(); // per-sid attached state as of the prior reconcile, for diffing transitions

  constructor(tmux: TmuxRunner = realTmux) {
    this.tmux = tmux;
  }

  /** Rebuilds all in-memory state from live tmux; returns sids that vanished and sids whose grid's attached state flipped either way. */
  reconcile(): { vanished: string[]; attachChanged: { sid: string; attached: boolean }[] } {
    const previouslyTracked = new Set(this.sidToPane.keys());
    const panes = this.tmux.listPanesAll();

    this.grids = new Map();
    this.sidToPane = new Map();
    for (const p of panes) {
      const gridId = gridIdFromSession(p.session);
      if (!gridId || p.sid == null) continue; // foreign session, or an untagged pane we don't own
      let grid = this.grids.get(gridId);
      if (!grid) {
        grid = { gridId, session: p.session, panes: [], attached: p.attached };
        this.grids.set(gridId, grid);
      }
      grid.panes.push({ paneId: p.paneId, sid: p.sid });
      grid.attached = grid.attached || p.attached;
      if (!p.sid.startsWith(PENDING_PREFIX)) {
        this.sidToPane.set(p.sid, { gridId, paneId: p.paneId });
      }
    }
    if (this.activeGridId && !this.grids.has(this.activeGridId)) this.activeGridId = null;

    const vanished = [...previouslyTracked].filter((sid) => !this.sidToPane.has(sid));

    // A grid's attached flag can flip both ways with all its panes still alive (terminal window
    // closed/reopened without killing the underlying pane) — vanished-only tracking misses that, so
    // the dot lags until the next full poll. Diff every still-tracked sid's attached state too.
    const nextAttached = new Map<string, boolean>();
    const attachChanged: { sid: string; attached: boolean }[] = [];
    for (const grid of this.grids.values()) {
      for (const p of grid.panes) {
        if (p.sid.startsWith(PENDING_PREFIX)) continue;
        nextAttached.set(p.sid, grid.attached);
        if (this.lastAttached.get(p.sid) !== grid.attached) attachChanged.push({ sid: p.sid, attached: grid.attached });
      }
    }
    this.lastAttached = nextAttached;

    void this.persist();
    return { vanished, attachChanged };
  }

  private async persist(): Promise<void> {
    const dump = { grids: Object.fromEntries(this.grids), activeGrid: this.activeGridId };
    try {
      await writeFile(TMUX_STATE_PATH, JSON.stringify(dump, null, 2));
    } catch {
      // best-effort cache only — tmux remains canonical either way
    }
  }

  resolvePane(sid: string): PaneEntry & { gridId: GridId } | null {
    const hit = this.sidToPane.get(sid);
    if (!hit) return null;
    return { gridId: hit.gridId, paneId: hit.paneId, sid };
  }

  // Shared by anything that removes a pane from a grid without tearing the whole thing down (close,
  // isolate-on-resume below) — re-tiles the survivors per the ladder instead of leaving stale geometry.
  private reapplyLayout(grid: Grid): void {
    const layout = layoutForCount(grid.panes.length);
    if (layout) this.tmux.selectLayout(grid.session, layout);
    this.tmux.setPaneBorderStatus(grid.session, grid.panes.length > 1);
  }

  // Grids are ad-hoc and never remembered: a pane whose grid is detached (no terminal open) but
  // still holds sibling panes tiled in from other sessions is a stale leftover group, not something a
  // reopen should resurrect wholesale. Isolates just the requested pane into its own fresh grid first
  // so the reopen starts a clean, full-size window and the ad-hoc ladder can build back up from there.
  resolveForResume(sid: string): { gridId: GridId; paneId: string; session: string; attached: boolean } | null {
    this.reconcile();
    const pane = this.resolvePane(sid);
    if (!pane) return null;
    const grid = this.grids.get(pane.gridId);
    if (!grid) return null;
    if (!grid.attached && grid.panes.length > 1) {
      const gridId = randomUUID().slice(0, 8);
      const session = `csm-grid-${gridId}`;
      if (this.tmux.isolatePane(pane.paneId, session)) {
        this.tmux.setSessionStatusOff(session);
        this.reconcile();
        const oldGrid = this.grids.get(pane.gridId);
        if (oldGrid && oldGrid.panes.length > 0) this.reapplyLayout(oldGrid);
        this.activeGridId = gridId;
        return { gridId, paneId: pane.paneId, session, attached: false };
      }
    }
    return { gridId: pane.gridId, paneId: pane.paneId, session: grid.session, attached: grid.attached };
  }

  isAttached(sid: string): boolean {
    const hit = this.sidToPane.get(sid);
    if (!hit) return false;
    return this.grids.get(hit.gridId)?.attached ?? false;
  }

  listGrids(): Grid[] {
    return [...this.grids.values()];
  }

  private pickTargetGrid(): Grid | null {
    const active = this.activeGridId ? this.grids.get(this.activeGridId) : null;
    if (active && active.attached && active.panes.length < MAX_PANES_PER_GRID) return active;
    for (const g of this.grids.values()) {
      if (g.attached && g.panes.length < MAX_PANES_PER_GRID) return g;
    }
    return null;
  }

  /** Starts (or reuses) a pane for `sid`, auto-tiling into the currently open grid, spilling into a new one at 4 panes. `label` seeds the pane's border/title so it's never blank before the first rename. */
  openOrCreate(
    sid: string,
    argv: string[],
    cwd?: string,
    label?: string,
  ): { gridId: GridId; paneId: string; created: boolean; needsTerminal: boolean } | null {
    this.reconcile();
    const existing = this.resolvePane(sid);
    if (existing) return { gridId: existing.gridId, paneId: existing.paneId, created: false, needsTerminal: false };

    // pickTargetGrid only ever returns an already-attached grid, so joining it needs no new window.
    const target = this.pickTargetGrid();
    if (target) {
      const paneId = this.tmux.splitWindow(target.session, argv, cwd);
      if (!paneId) return null;
      this.tmux.setPaneOption(paneId, "@csm_sid", sid);
      if (label) this.tmux.setPaneTitle(paneId, label);
      target.panes.push({ paneId, sid });
      const layout = layoutForCount(target.panes.length);
      if (layout) this.tmux.selectLayout(target.session, layout);
      // pane-border-status only earns its keep once there's more than one pane to tell apart
      this.tmux.setPaneBorderStatus(target.session, target.panes.length > 1);
      this.sidToPane.set(sid, { gridId: target.gridId, paneId });
      this.activeGridId = target.gridId;
      this.tmux.selectPane(paneId);
      void this.persist();
      return { gridId: target.gridId, paneId, created: true, needsTerminal: false };
    }

    const created = this.createGrid(sid, argv, cwd, label);
    if (!created) return null;
    return { ...created, created: true, needsTerminal: true };
  }

  private createGrid(sid: string, argv: string[], cwd?: string, label?: string): { gridId: GridId; paneId: string } | null {
    const gridId = randomUUID().slice(0, 8);
    const session = `csm-grid-${gridId}`;
    const paneId = this.tmux.newSession(session, argv, cwd);
    if (!paneId) return null;
    this.tmux.setPaneOption(paneId, "@csm_sid", sid);
    if (label) this.tmux.setPaneTitle(paneId, label);
    this.tmux.setSessionStatusOff(session);
    this.grids.set(gridId, { gridId, session, panes: [{ paneId, sid }], attached: false });
    this.sidToPane.set(sid, { gridId, paneId });
    this.activeGridId = gridId;
    this.tmux.selectPane(paneId);
    void this.persist();
    return { gridId, paneId };
  }

  // Bypasses pickTargetGrid entirely — used for headless-launch paths that must never spill a pane
  // into the user's currently visible window (a not-running session's Quick Prompt, spec §7.5).
  openStandalone(sid: string, argv: string[], cwd?: string, label?: string): { gridId: GridId; paneId: string } | null {
    this.reconcile();
    const existing = this.resolvePane(sid);
    if (existing) return { gridId: existing.gridId, paneId: existing.paneId };
    return this.createGrid(sid, argv, cwd, label);
  }

  /** Starts a fork pane tagged with a pending sentinel — owned (never reaped) but not sid-resolvable until `resolveForkSid`. */
  openForkPending(
    argv: string[],
    cwd?: string,
    label?: string,
  ): { gridId: GridId; paneId: string; pendingSid: string; needsTerminal: boolean } | null {
    const pendingSid = `${PENDING_PREFIX}${randomUUID()}`;
    const result = this.openOrCreate(pendingSid, argv, cwd, label);
    if (!result) return null;
    return { gridId: result.gridId, paneId: result.paneId, pendingSid, needsTerminal: result.needsTerminal };
  }

  /** Retags a pending fork pane (or a /clear-reconciled pane) once its real sid is known. */
  resolveForkSid(paneId: string, realSid: string): void {
    this.tmux.setPaneOption(paneId, "@csm_sid", realSid);
    this.reconcile();
  }

  /** Retags the pane currently tagged `oldSid` to `newSid` (a /clear happened underneath it). */
  remapSid(oldSid: string, newSid: string): boolean {
    const pane = this.resolvePane(oldSid);
    if (!pane) return false;
    this.resolveForkSid(pane.paneId, newSid);
    return true;
  }

  /** Kills the pane for `sid` and re-tiles any survivors; returns false if no live pane was found. */
  closeSession(sid: string): boolean {
    this.reconcile();
    const pane = this.resolvePane(sid);
    if (!pane) return false;
    this.tmux.killPane(pane.paneId);
    this.reconcile();
    const grid = this.grids.get(pane.gridId);
    if (grid && grid.panes.length > 0) {
      this.reapplyLayout(grid);
    } else {
      this.tmux.killSession(`csm-grid-${pane.gridId}`);
    }
    return true;
  }

  focus(sid: string): boolean {
    const pane = this.resolvePane(sid);
    if (!pane) return false;
    return this.tmux.selectPane(pane.paneId);
  }

  // Dashboard metadata is the source of truth for a session's display name — this keeps an
  // already-open pane's tag in sync AND pushes the new name straight to the terminal's title bar
  // (via set-titles-string, see tmux.ts), a no-op if the session isn't currently running anywhere.
  setName(sid: string, name: string): void {
    const pane = this.resolvePane(sid);
    if (!pane) return;
    this.tmux.setPaneOption(pane.paneId, "@csm_name", name);
    this.tmux.setPaneTitle(pane.paneId, name);
  }

  getPanePid(paneId: string): number | null {
    return this.tmux.listPanesAll().find((p) => p.paneId === paneId)?.pid ?? null;
  }
}

export const grids = new GridManager();

let pollerStarted = false;
/** Periodically reconciles against live tmux; reports vanished sids and attach/detach transitions, replacing the old Ghostty orphan watcher. */
export function startTmuxReconciliationPoller(
  onVanished: (sid: string) => void,
  onAttachChanged: (sid: string, attached: boolean) => void,
  intervalMs = 3000,
): void {
  if (pollerStarted) return;
  pollerStarted = true;
  setInterval(() => {
    try {
      const { vanished, attachChanged } = grids.reconcile();
      for (const sid of vanished) onVanished(sid);
      for (const { sid, attached } of attachChanged) onAttachChanged(sid, attached);
    } catch {
      // a transient tmux CLI failure shouldn't take the poller down
    }
  }, intervalMs);
}
