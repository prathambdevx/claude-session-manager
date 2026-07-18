// Top-level dispatcher: decides main-board vs. drilled-in-project-board, and holds the
// toolbar-driven filtering (search/date/project) that every one of those views shares.
import {
  sessions, boardMode, activeProjectCwd, contentMatchIds, activeView, savedViews,
} from "../state.js";
import { mainBoardCtx, projectBoardCtx, savedViewCtx, projectBreadcrumbHtml } from "../routing/boardRouting.js";
import { renderBoardView } from "../components/board/renderBoardView.js";
import { renderProjectsLens } from "../components/board/renderProjectsLens.js";
import { renderSidebar } from "../components/sidebar/renderSidebar.js";

// True while the user is mid-interaction with a piece of UI that a full board rebuild
// (render()'s app.innerHTML replace) would destroy out from under them — an open ⋮ dropdown or an
// in-progress inline column rename. Background refreshers (SSE pushes, the backstop poll) check
// this and skip the visual rebuild while it's true; the underlying state is still updated, so the
// next refresh after the menu closes shows current data. Without this, a card/column ⋮ menu would
// vanish the instant the next SSE push landed (~1s while sessions are active) — reading as "the
// menu closes by itself." Modals live in a separate #modalRoot that render() never touches, so
// they don't need to be covered here.
export function isTransientUiOpen() {
  return !!document.querySelector(".bc-dropdown.open, [data-rename-col-input]");
}

export function matchesSearch(s, q) {
  if (!q) return true;
  q = q.toLowerCase();
  const hay = [
    s.meta?.name, s.meta?.description, s.firstMessage, s.cwd, s.gitBranch,
    ...(s.meta?.tags || []), s.meta?.notes, s.id,
  ].filter(Boolean).join(" ").toLowerCase();
  return hay.includes(q) || contentMatchIds.has(s.id);
}

export function render() {
  renderSidebar();
  const q = document.getElementById("search").value.trim();

  if (boardMode === "project") {
    const filtered = sessions.filter((s) => s.cwd === activeProjectCwd && matchesSearch(s, q));
    document.getElementById("statLine").textContent = `${filtered.length} session${filtered.length === 1 ? "" : "s"} shown`;
    renderBoardView(filtered, projectBoardCtx(activeProjectCwd), projectBreadcrumbHtml());
    return;
  }

  const dateFilter = document.getElementById("filterDate").value;
  const projectFilter = document.getElementById("filterProject").value;
  const dateCutoff = dateFilter ? Date.now() - Number(dateFilter) * 86400000 : null;

  let filtered = sessions.filter((s) => {
    if (projectFilter && s.cwd !== projectFilter) return false;
    if (dateCutoff && s.lastActive < dateCutoff) return false;
    return matchesSearch(s, q);
  });

  document.getElementById("statLine").textContent =
    `${filtered.length} session${filtered.length === 1 ? "" : "s"} shown · ${sessions.filter(s => s.running).length} currently running`;

  if (activeView === "group") { renderProjectsLens(filtered); return; }
  if (activeView.startsWith("saved:")) {
    const view = savedViews.find((v) => v.id === activeView.slice(6));
    if (view) { renderBoardView(filtered, savedViewCtx(view)); return; }
  }
  renderBoardView(filtered, mainBoardCtx());
}
