// Top-level dispatcher: decides main-board vs. drilled-in-project-board, and holds the
// toolbar-driven filtering (search/date/project) that every one of those views shares.
import {
  sessions, boardMode, activeProjectCwd, contentMatchIds, activeView, savedViews,
} from "../state.js";
import { mainBoardCtx, projectBoardCtx, groupBoardCtx, savedViewCtx, projectBreadcrumbHtml } from "../routing/boardRouting.js";
import { renderBoardView } from "../components/board/renderBoardView.js";
import { renderSidebar } from "../components/sidebar/renderSidebar.js";

// True while an open ⋮ dropdown or inline column rename exists — background refreshers (SSE,
// backstop poll) check this and skip the destructive full rebuild until it closes.
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

  if (activeView === "group") { renderBoardView(filtered.filter((s) => !s.isTicket), groupBoardCtx()); return; }
  if (activeView.startsWith("saved:")) {
    const view = savedViews.find((v) => v.id === activeView.slice(6));
    if (view) { renderBoardView(filtered, savedViewCtx(view)); return; }
  }
  renderBoardView(filtered, mainBoardCtx());
}
