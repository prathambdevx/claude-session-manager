// Board column state + the "boardMode" routing state machine. The URL (not localStorage) is the
// source of truth: "/" = main board, "/projects/<cwd>" = a drilled-in project's own board.
import {
  boardColumns, setBoardColumns, boardMode, setBoardModeState, activeProjectCwd,
  setActiveProjectCwd, projectBoards, setProjectBoards, currentProjectColumns,
  setCurrentProjectColumns, groupBoardColumns, setGroupBoardColumns, DEFAULT_COLUMNS, OLD_DEFAULT_ORDER, sessions,
} from "../state.js";
import { escapeHtml, projectName } from "../ui/format.js";
import { toast } from "../ui/toast.js";
import { pushHistory } from "../components/board/boardUndo.js";

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

// Appends a column for any project cwd not already represented, leaving every existing column
// untouched. Idempotent — safe to call even when nothing needs to change.
export function mergeInProjectColumns(cols, sessionList) {
  const existingCwds = new Set(cols.filter((c) => c.cwd).map((c) => c.cwd));
  const cwds = [...new Set(sessionList.filter((s) => s.cwd && !existingCwds.has(s.cwd)).map((s) => s.cwd))]
    .sort((a, b) => projectName(a).localeCompare(projectName(b)));
  if (!cwds.length) return { columns: cols, changed: false };
  const seenIds = new Set(cols.map((c) => c.id));
  const added = cwds.map((cwd) => {
    let id = projectColumnId(cwd);
    let n = 2;
    while (seenIds.has(id)) id = `${projectColumnId(cwd)}-${n++}`; // dedupe two dirs sharing a basename
    seenIds.add(id);
    return { id, title: projectName(cwd), cwd };
  });
  return { columns: [...cols, ...added], changed: true };
}

export function boardModeFromLocation() {
  const path = location.pathname;
  const m = path.match(/^\/projects\/(.+)$/);
  if (m) return { mode: "project", cwd: decodeURIComponent(m[1]) };
  return { mode: "main", cwd: null };
}

// Called once at boot (main.js) to seed state.js's boardMode/activeProjectCwd/currentProjectColumns
// from the current URL, mirroring what the old top-level module-init code did synchronously.
export function initBoardStateFromLocation() {
  const initial = boardModeFromLocation();
  setBoardModeState(initial.mode);
  setActiveProjectCwd(initial.cwd);
  // Seeded synchronously with DEFAULT_COLUMNS so a hard reload into /projects/<cwd> has something
  // to render before loadSessions() resolves with the real columns.
  setCurrentProjectColumns(initial.mode === "project" ? DEFAULT_COLUMNS.slice() : null);
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

export async function setBoardTag(ctx, cardId, colId) {
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
  const isFirstVisit = !projectBoards[cwd];
  if (isFirstVisit) setProjectBoards({ ...projectBoards, [cwd]: DEFAULT_COLUMNS.slice() }); // same defaults as the main board
  setCurrentProjectColumns(projectBoards[cwd]);
  if (isFirstVisit) await saveProjectBoardColumns(cwd);
  await setBoardMode("project");
}

// browser back/forward — re-derive state from the URL bar rather than trusting popstate's
// event.state (works even if the user typed/edited the URL directly, not just navigated via it)
export function wirePopstate() {
  window.addEventListener("popstate", () => {
    const { mode, cwd } = boardModeFromLocation();
    setBoardModeState(mode);
    setActiveProjectCwd(cwd);
    if (mode === "project" && cwd) {
      setCurrentProjectColumns(projectBoards[cwd] || DEFAULT_COLUMNS.slice());
    }
    import("../pages/sessionsPage.js").then((m) => m.render());
  });
}

// Keeps the home column ("All sessions") first, then every project column, then every custom
// (plain-tag) column — the order "Regroup by project" is named for. Relative order within each
// group is preserved so this never reshuffles columns the user has deliberately arranged.
function reorderProjectColumnsFirst(cols) {
  if (cols.length <= 1) return cols;
  const [home, ...rest] = cols;
  const projectCols = rest.filter((c) => c.cwd);
  const customCols = rest.filter((c) => !c.cwd);
  return [home, ...projectCols, ...customCols];
}

function sameOrder(a, b) {
  return a.length === b.length && a.every((c, i) => c.id === b[i].id);
}

// "Regroup by project" — repeatable (unlike mergeInProjectColumns' one-time gated migration);
// callable any time a project column has drifted missing. Generic over ctx so it also works for
// the "Projects" group lens, which has no home column to keep pinned first (every column there
// already has a .cwd), unlike Main board.
export async function ensureAllProjectColumns(ctx = mainBoardCtx()) {
  const merged = mergeInProjectColumns(ctx.cols, sessions);
  const reordered = ctx.kind === "group" ? merged.columns : reorderProjectColumnsFirst(merged.columns);
  const addedCount = merged.columns.length - ctx.cols.length;

  if (!merged.changed && sameOrder(reordered, ctx.cols)) {
    toast("Every project already has a column, in order");
    return;
  }

  pushHistory(ctx); // so the global Undo button can revert this too
  ctx.cols = reordered;
  await ctx.save();
  toast(addedCount > 0
    ? `Added ${addedCount} column${addedCount === 1 ? "" : "s"} for project${addedCount === 1 ? "" : "s"} without one`
    : "Reordered — project columns first");
  await import("../pages/sessionsPage.js").then((m) => m.render());
}

// Drop a card onto a sidebar project entry — a session's cwd is fixed (same rule as the board's
// own project columns); only a ticket can be tagged onto a different one.
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

  if (!card.isTicket) {
    if (card.cwd !== cwd) {
      toast(`Can't move — this session belongs to "${projectName(card.cwd)}", not "${projectName(cwd)}"`);
      return;
    }
    await ensureProjectColumnFor(cwd);
    toast(`Already belongs to "${projectName(cwd)}"`);
    await import("../pages/sessionsPage.js").then((m) => m.render());
    return;
  }

  const col = await ensureProjectColumnFor(cwd);
  await setBoardTag(mainBoardCtx(), cardId, col?.id ?? null);
  toast(`Moved onto "${projectName(cwd)}"`);
}

// Breadcrumb header shown atop a drilled-in project's board.
export function projectBreadcrumbHtml() {
  return `
    <div class="board-breadcrumb">
      <button data-back-to-main>← Back to board</button>
      <h2>${escapeHtml(projectName(activeProjectCwd))}</h2>
    </div>
  `;
}
