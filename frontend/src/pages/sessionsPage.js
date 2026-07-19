// Top-level dispatcher: decides main-board vs. drilled-in-project-board, and holds the
// toolbar-driven filtering (search/date/project) that every one of those views shares.
import {
  sessions, boardMode, activeProjectCwd, contentMatchIds, activeView, savedViews, projectFilter,
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
  const dateCutoff = dateFilter ? Date.now() - Number(dateFilter) * 86400000 : null;

  // projectFilter is NOT applied here — it only narrows the home column (see renderBoardView),
  // so a custom/project column you've already organized stays exactly as it is regardless of
  // whatever you're currently filtering the home column down to.
  let filtered = sessions.filter((s) => {
    if (dateCutoff && s.lastActive < dateCutoff) return false;
    return matchesSearch(s, q);
  });

  // The filter only ever narrows a real home column — the group lens has none (every column there
  // IS a project already), and neither does a saved view snapshotted from it, so the stat line
  // shouldn't apply a stale projectFilter to either; it'd otherwise show a leftover narrowed count
  // that has nothing to do with what's actually on screen.
  const hasHomeColumn = activeView !== "group"
    && (!activeView.startsWith("saved:") || !savedViews.find((v) => v.id === activeView.slice(6))?.columns[0]?.cwd);
  const shownCount = hasHomeColumn && projectFilter ? filtered.filter((s) => s.cwd === projectFilter).length : filtered.length;
  document.getElementById("statLine").textContent =
    `${shownCount} session${shownCount === 1 ? "" : "s"} shown · ${sessions.filter(s => s.running).length} currently running`;

  if (activeView === "group") { renderBoardView(filtered.filter((s) => !s.isTicket), groupBoardCtx()); return; }
  if (activeView.startsWith("saved:")) {
    const view = savedViews.find((v) => v.id === activeView.slice(6));
    if (view) { renderBoardView(filtered, savedViewCtx(view), "", projectFilter); return; }
  }
  renderBoardView(filtered, mainBoardCtx(), "", projectFilter);
}
