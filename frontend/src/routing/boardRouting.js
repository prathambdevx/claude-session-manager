// Board column state/migration, plus the "boardMode" routing state machine: clicking a project
// column on the main board drills INTO that project's own, independently persisted board (its own
// columns, separate from the main board's).
//
// The URL is the source of truth for which view is showing (not localStorage), so a hard reload
// or a shared link lands back on the same page: "/" = main board, "/projects/<encoded-cwd>" = a
// drilled-in project's own board. The server (backend/src/routes.ts) serves index.html for both
// so a direct/reloaded request works too. A bare "/projects" (from before the project picker was
// merged into the main board) harmlessly falls through to "main" below.
import {
  boardColumns, setBoardColumns, boardMode, setBoardModeState, activeProjectCwd,
  setActiveProjectCwd, projectBoards, setProjectBoards, currentProjectColumns,
  setCurrentProjectColumns, DEFAULT_COLUMNS, OLD_DEFAULT_ORDER, sessions,
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

// Client-only per-column flags (e.g. "never populated yet, so exempt from auto-hide-empty") live
// only in memory on the current column objects — they're never sent to/from the server. Every
// poll (loadSessions) replaces the whole columns array with freshly-parsed objects from
// the server response, which would otherwise silently drop these flags out from under the user a
// few seconds after they took effect. Carry them forward by matching column id.
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

// Appends a column for any project cwd not already represented (matched by BoardColumn.cwd),
// leaving every existing column — custom or otherwise — untouched. Idempotent: safe to call even
// when nothing needs to change. This is what makes the main board default to "one column per
// project" on a fresh install while never disturbing an existing install's own columns — it just
// fills in whatever project columns are missing, wherever the board currently stands.
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
  // BoardColumn[] for whichever project is currently drilled into. Seeded synchronously with
  // DEFAULT_COLUMNS (mirroring how `boardColumns` itself defaults synchronously) so a hard reload
  // straight into /projects/<cwd> has something non-null to render with before loadSessions()'s
  // fetch resolves and replaces this with the project's real saved columns (or these same defaults).
  setCurrentProjectColumns(initial.mode === "project" ? DEFAULT_COLUMNS.slice() : null);
}

export async function saveProjectBoardColumns(cwd) {
  await fetch("/api/project-board", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ cwd, columns: currentProjectColumns }),
  });
}

// ctx objects let renderBoardView work against either the main board or a per-project board
// without duplicating its ~200 lines of column-management/drag-and-drop code. `cols` is a
// getter/setter so a reassignment inside renderBoardView (e.g. removing a column) writes through
// to the right global instead of just rebinding a local parameter.
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

// A saved view previews as its own board — same permanent project-column membership rules as
// Main board (kind: "main"), but edits persist back into that saved view's own column snapshot
// instead of touching the live Main board.
export function savedViewCtx(view) {
  return {
    kind: "main",
    get cols() { return view.columns; },
    set cols(v) { view.columns = v; },
    save: () => import("../api/savedViewsApi.js").then((m) => m.saveSavedViewColumns(view.id, view.columns)),
  };
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

// ---------- "Regroup by project" — repeatable, not just the one-time first-load migration
// (mergeInProjectColumns above) that's gated behind localStorage. Callable any time a project's
// column has drifted missing (e.g. a brand-new project cwd shows up after that gate has already
// fired once for this browser), and also whenever columns need re-sorting back to
// projects-then-custom order ----------
export async function ensureAllProjectColumns() {
  const merged = mergeInProjectColumns(boardColumns, sessions);
  const reordered = reorderProjectColumnsFirst(merged.columns);
  const addedCount = merged.columns.length - boardColumns.length;

  if (!merged.changed && sameOrder(reordered, boardColumns)) {
    toast("Every project already has a column, in order");
    return;
  }

  pushHistory(mainBoardCtx()); // so the global Undo button can revert this too
  setBoardColumns(reordered);
  await import("../api/sessionsApi.js").then((m) => m.saveBoardColumns());
  toast(addedCount > 0
    ? `Added ${addedCount} column${addedCount === 1 ? "" : "s"} for project${addedCount === 1 ? "" : "s"} without one`
    : "Reordered — project columns first");
  await import("../pages/sessionsPage.js").then((m) => m.render());
}

// ---------- idea 6: drop a card straight onto a sidebar project entry. A session's project is
// fixed (its `cwd`), same rule as dropping it on a project column on the board itself — only a
// ticket (no fixed project) can actually be tagged onto a different one this way ----------
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
  const { patchMeta } = await import("../api/sessionsApi.js");
  await patchMeta(cardId, { board: col?.id });
  toast(`Moved onto "${projectName(cwd)}"`);
}

// ---------- breadcrumb header shown atop a drilled-in project's board ----------
export function projectBreadcrumbHtml() {
  return `
    <div class="board-breadcrumb">
      <button data-back-to-main>← Back to board</button>
      <h2>${escapeHtml(projectName(activeProjectCwd))}</h2>
    </div>
  `;
}
