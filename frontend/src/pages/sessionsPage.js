// Top-level dispatcher: decides main-board vs. drilled-in-project-board vs. list view, and holds
// the toolbar-driven filtering (search/sort/date/project) that every one of those views shares.
import {
  sessions, boardMode, activeProjectCwd, currentView, setCurrentView, contentMatchIds, activeView, savedViews,
} from "../state.js";
import { mainBoardCtx, projectBoardCtx, savedViewCtx, projectBreadcrumbHtml } from "../routing/boardRouting.js";
import { renderBoardView } from "../components/board/renderBoardView.js";
import { renderListView } from "../components/listView/renderListView.js";
import { renderProjectsLens } from "../components/board/renderProjectsLens.js";
import { renderSidebar } from "../components/sidebar/renderSidebar.js";

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

  const sortMode = document.getElementById("sort").value;
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

  if (currentView === "board") {
    if (activeView === "group") { renderProjectsLens(filtered); return; }
    if (activeView.startsWith("saved:")) {
      const view = savedViews.find((v) => v.id === activeView.slice(6));
      if (view) { renderBoardView(filtered, savedViewCtx(view)); return; }
    }
    renderBoardView(filtered, mainBoardCtx());
    return;
  }
  renderListView(filtered, sortMode);
}

export function setView(v) {
  setCurrentView(v);
  localStorage.setItem("currentView", v);
  document.getElementById("viewList").classList.toggle("active", v === "list");
  document.getElementById("viewBoard").classList.toggle("active", v === "board");
  document.getElementById("sort").style.display = v === "board" ? "none" : "";
  document.getElementById("app").classList.toggle("board-mode", v === "board");
  render();
}
