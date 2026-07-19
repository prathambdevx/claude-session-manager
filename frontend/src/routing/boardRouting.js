// Board column state + the URL routing state machine. The URL (not localStorage) is the source of
// truth for which view is showing, so a refresh/back/forward stays put:
//   "/"                = Main board
//   "/projects"        = All Projects (the group lens)
//   "/projects/<cwd>"  = a drilled-in project's own board
//   "/views/<id>"      = a saved view
import {
  boardColumns, setBoardColumns, boardMode, setBoardModeState, activeProjectCwd,
  setActiveProjectCwd, projectBoards, setProjectBoards, currentProjectColumns,
  setCurrentProjectColumns, groupBoardColumns, setGroupBoardColumns, setActiveView,
  DEFAULT_COLUMNS, PROJECT_DEFAULT_COLUMNS, OLD_DEFAULT_ORDER, sessions,
} from "../state.js";
import { escapeHtml, projectName } from "../ui/format.js";
import { toast } from "../ui/toast.js";

export function migrateColumns(cols) {
  if (cols.map((c) => c.id).join(",") === OLD_DEFAULT_ORDER.join(",")) return DEFAULT_COLUMNS.slice();
  const todo = cols.find((c) => c.id === "todo");
  if (todo && todo.title === "To Do") todo.title = "All sessions";
  return cols;
}

// Client-only column flags (e.g. neverPopulated) live only in memory — carry them forward by
// column id so a poll's fresh column objects don't silently drop them.
const TRANSIENT_COLUMN_FLAGS = ["neverPopulated"];
export function carryTransientColumnFlags(oldCols, newCols) {
  if (!oldCols?.length) return newCols;
  const byId = new Map(oldCols.map((c) => [c.id, c]));
  for (const c of newCols) {
    const old = byId.get(c.id);
    if (!old) continue;
    for (const flag of TRANSIENT_COLUMN_FLAGS) if (old[flag]) c[flag] = old[flag];
  }
  return newCols;
}

export function projectColumnId(cwd) {
  return "proj-" + projectName(cwd).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
}

const STALE_PROJECT_MS = 14 * 24 * 60 * 60 * 1000;

// Most recent lastActive among a project's own sessions — 0 if it has none (never sorts first,
// never counts as stale-but-active).
export function projectRecency(cwd, sessionList) {
  let max = 0;
  for (const s of sessionList) if (s.cwd === cwd && s.lastActive > max) max = s.lastActive;
  return max;
}

// Appends a column for any project cwd not already represented, leaving every existing column
// untouched. Idempotent — safe to call even when nothing needs to change. A newly added column
// for a project untouched in 14+ days starts collapsed — an already-existing column's collapsed
// state is never touched here, so a manual expand/collapse survives a later re-run.
export function mergeInProjectColumns(cols, sessionList) {
  const existingCwds = new Set(cols.filter((c) => c.cwd).map((c) => c.cwd));
  const cwds = [...new Set(sessionList.filter((s) => s.cwd && !existingCwds.has(s.cwd)).map((s) => s.cwd))]
    .sort((a, b) => projectName(a).localeCompare(projectName(b)));
  if (!cwds.length) return { columns: cols, changed: false };
  const seenIds = new Set(cols.map((c) => c.id));
  const now = Date.now();
  const added = cwds.map((cwd) => {
    let id = projectColumnId(cwd);
    let n = 2;
    while (seenIds.has(id)) id = `${projectColumnId(cwd)}-${n++}`; // dedupe two dirs sharing a basename
    seenIds.add(id);
    const lastActive = projectRecency(cwd, sessionList);
    const stale = lastActive > 0 && now - lastActive > STALE_PROJECT_MS;
    return { id, title: projectName(cwd), cwd, ...(stale ? { collapsed: true } : {}) };
  });
  return { columns: [...cols, ...added], changed: true };
}

export function boardModeFromLocation() {
  const path = location.pathname;
  const proj = path.match(/^\/projects\/(.+)$/);
  if (proj) return { mode: "project", cwd: decodeURIComponent(proj[1]), activeView: "project" };
  if (path === "/projects") return { mode: "main", cwd: null, activeView: "group" };
  const view = path.match(/^\/views\/(.+)$/);
  if (view) return { mode: "main", cwd: null, activeView: "saved:" + decodeURIComponent(view[1]) };
  return { mode: "main", cwd: null, activeView: "main" };
}

// The URL a given view should live at — inverse of boardModeFromLocation.
export function pathForActiveView(view) {
  if (view === "group") return "/projects";
  if (view?.startsWith("saved:")) return "/views/" + encodeURIComponent(view.slice(6));
  return "/";
}

// Called once at boot (main.js) to seed state.js's boardMode/activeProjectCwd/currentProjectColumns
// from the current URL, mirroring what the old top-level module-init code did synchronously.
export function initBoardStateFromLocation() {
  const initial = boardModeFromLocation();
  setBoardModeState(initial.mode);
  setActiveProjectCwd(initial.cwd);
  setActiveView(initial.activeView);
  // Seeded synchronously with PROJECT_DEFAULT_COLUMNS so a hard reload into /projects/<cwd> has
  // something to render before loadSessions() resolves with the real columns.
  setCurrentProjectColumns(initial.mode === "project" ? PROJECT_DEFAULT_COLUMNS.slice() : null);
}

// Canonical view navigation for the non-project views (Main / All Projects / a saved view):
// updates state, pushes the matching URL, and re-renders. Project boards go through
// enterProjectBoard instead (they also load that project's columns).
export async function switchToView(view) {
  setBoardModeState("main");
  setActiveProjectCwd(null);
  setActiveView(view);
  history.pushState({}, "", pathForActiveView(view));
  await import("../pages/sessionsPage.js").then((m) => m.render());
}

export async function saveProjectBoardColumns(cwd) {
  await fetch("/api/project-board", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ cwd, columns: currentProjectColumns }),
  });
}

// ctx objects let renderBoardView target either board without duplicating its column/drag-drop
// code — cols is a getter/setter so reassignment writes through to the right global.
export function mainBoardCtx() {
  return {
    kind: "main",
    get cols() { return boardColumns; },
    set cols(v) { setBoardColumns(v); },
    save: () => import("../api/sessionsApi.js").then((m) => m.saveBoardColumns()),
  };
}
export function projectBoardCtx(cwd) {
  return {
    kind: "project",
    cwd,
    get cols() { return currentProjectColumns; },
    set cols(v) {
      setCurrentProjectColumns(v);
      setProjectBoards({ ...projectBoards, [cwd]: v });
    },
    save: () => saveProjectBoardColumns(cwd),
  };
}

// The "Projects" sidebar view — auto-seeded with one column per project (see loadSessions), then
// manageable exactly like Main board's own project columns: draggable, hideable, renameable.
export function groupBoardCtx() {
  return {
    kind: "group",
    get cols() { return groupBoardColumns; },
    set cols(v) { setGroupBoardColumns(v); },
    save: () => import("../api/sessionsApi.js").then((m) => m.saveGroupBoardColumns()),
  };
}

// A saved view previews as its own board (same rules as kind:"main"), but edits persist to its own
// column snapshot, never the live Main board. viewId is what lets ctxKey tell it apart from the
// real Main board, since both share kind:"main" purely for rendering purposes.
export function savedViewCtx(view) {
  return {
    kind: "main",
    viewId: view.id,
    get cols() { return view.columns; },
    set cols(v) { view.columns = v; },
    save: () => import("../api/savedViewsApi.js").then((m) => m.saveSavedViewColumns(view.id, view.columns)),
  };
}

// Identifies which board a custom-column card placement belongs to — Main board, a saved view, or
// a per-project board each get their own independent slot in a card's boardTags map.
export function ctxKey(ctx) {
  if (ctx.viewId) return `saved:${ctx.viewId}`;
  if (ctx.kind === "group") return "group";
  return ctx.kind === "main" ? "main" : `project:${ctx.cwd}`;
}

// board (the legacy flat field) is read as a fallback for EVERY context, not just "main" — every
// board/view historically shared that one field indiscriminately, so a saved view or per-project
// board that already had cards tagged before this change must keep seeing them. Once a card gets
// tagged in a specific context going forward, its boardTags entry for that key takes over and this
// fallback is no longer consulted for it.
export function boardTagFor(ctx, s) {
  const fromMap = s.meta?.boardTags?.[ctxKey(ctx)];
  if (fromMap !== undefined) return fromMap;
  return s.meta?.board ?? null;
}

// isTicket overrides the sessions-array lookup — needed right after creating a new ticket (or
// session), when it hasn't landed in local state yet (loadSessions() runs after this call, not
// before) — "not found locally" alone can't tell a brand-new ticket from a brand-new session.
export async function setBoardTag(ctx, cardId, colId, isTicket) {
  const s = sessions.find((x) => x.id === cardId);
  // Tickets live in their own store (data/tickets/), not meta.json — patchMeta's PUT
  // /api/sessions/:id/meta silently writes to the wrong place for one (no such session exists),
  // so a ticket's tag never persisted anywhere the board actually reads it.
  if (isTicket ?? s?.isTicket) {
    if (s) {
      // already loaded (e.g. being dragged) — update local state and render immediately, same as
      // patchMeta, so it moves on drop instead of waiting for the round-trip to finish
      s.meta = { ...s.meta, boardTags: { ...s.meta?.boardTags, [ctxKey(ctx)]: colId } };
      await import("../pages/sessionsPage.js").then((m) => m.render());
    }
    await fetch(`/api/tickets/${cardId}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ boardTags: { [ctxKey(ctx)]: colId } }),
    });
    return;
  }
  const { patchMeta } = await import("../api/sessionsApi.js");
  await patchMeta(cardId, { boardTags: { [ctxKey(ctx)]: colId } });
}

export function pathForBoardMode(mode, cwd) {
  if (mode === "project") return "/projects/" + encodeURIComponent(cwd);
  return "/";
}

export function setBoardMode(mode, { skipPush = false } = {}) {
  setBoardModeState(mode);
  if (mode !== "project") setActiveProjectCwd(null);
  if (!skipPush) history.pushState({ boardMode: mode, activeProjectCwd }, "", pathForBoardMode(mode, activeProjectCwd));
  return import("../pages/sessionsPage.js").then((m) => m.render());
}

export async function enterProjectBoard(cwd) {
  setActiveProjectCwd(cwd);
  setActiveView("project");
  const isFirstVisit = !projectBoards[cwd];
  if (isFirstVisit) setProjectBoards({ ...projectBoards, [cwd]: PROJECT_DEFAULT_COLUMNS.slice() });
  setCurrentProjectColumns(projectBoards[cwd]);
  if (isFirstVisit) await saveProjectBoardColumns(cwd);
  await setBoardMode("project");
}

// browser back/forward — re-derive state from the URL bar rather than trusting popstate's
// event.state (works even if the user typed/edited the URL directly, not just navigated via it)
export function wirePopstate() {
  window.addEventListener("popstate", () => {
    const { mode, cwd, activeView } = boardModeFromLocation();
    setBoardModeState(mode);
    setActiveProjectCwd(cwd);
    setActiveView(activeView);
    if (mode === "project" && cwd) {
      setCurrentProjectColumns(projectBoards[cwd] || PROJECT_DEFAULT_COLUMNS.slice());
    }
    import("../pages/sessionsPage.js").then((m) => m.render());
  });
}

// Drop a card onto a sidebar project entry — a session's cwd is fixed, so this only ever
// re-confirms it's already there. A ticket has no fixed project and is never allowed onto one.
async function ensureProjectColumnFor(cwd) {
  const merged = mergeInProjectColumns(boardColumns, sessions);
  if (merged.changed) {
    setBoardColumns(merged.columns);
    await import("../api/sessionsApi.js").then((m) => m.saveBoardColumns());
  }
  return boardColumns.find((c) => c.cwd === cwd);
}

export async function assignCardToProjectColumn(cardId, cwd) {
  const card = sessions.find((s) => s.id === cardId);
  if (!card) return;

  if (card.isTicket) { toast("Tickets can't be moved onto a project column"); return; }

  if (card.cwd !== cwd) {
    toast(`Can't move — this session belongs to "${projectName(card.cwd)}", not "${projectName(cwd)}"`);
    return;
  }
  await ensureProjectColumnFor(cwd);
  toast(`Already belongs to "${projectName(cwd)}"`);
  await import("../pages/sessionsPage.js").then((m) => m.render());
}

// Breadcrumb header shown atop a drilled-in project's board.
export function projectBreadcrumbHtml() {
  return `
    <div class="board-breadcrumb">
      <h2>${escapeHtml(projectName(activeProjectCwd))}</h2>
    </div>
  `;
}
