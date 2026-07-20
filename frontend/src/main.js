// Entry point — derives board routing from the URL first (must happen before the first render()),
// then wires DOM controls and starts polling.
import { currentTab, contentSearchTimer, setContentSearchTimer } from "./state.js";
import { initBoardStateFromLocation, wirePopstate, savedViewCtx, currentSavedView } from "./routing/boardRouting.js";
import { loadSessions, fetchContentMatches } from "./api/sessionsApi.js";
import { initLiveUpdates } from "./api/sse.js";
import { dangerousDefault } from "./ui/formFragments.js";
import { render } from "./pages/sessionsPage.js";
import { setTab, wireTabs } from "./pages/todosPage.js";
import { renderTodoBoard } from "./components/todoBoard/renderTodoBoard.js";
import { openGlobalSearchModal } from "./components/modals/globalSearchModal.js";
import { openColumnTaskModal } from "./components/modals/columnTaskModal.js";
import { openCommandPalette } from "./components/commandPalette/commandPalette.js";
import { closeModal } from "./ui/modalShell.js";
import { initThemeToggle } from "./components/theme/themeToggle.js";

initBoardStateFromLocation();
wirePopstate();

document.getElementById("search").addEventListener("input", (e) => {
  if (currentTab === "todos") { renderTodoBoard(); return; }
  render();
  clearTimeout(contentSearchTimer);
  setContentSearchTimer(setTimeout(() => fetchContentMatches(e.target.value), 350));
});

document.getElementById("filterDate").addEventListener("change", render);

const globalDangerousBox = document.getElementById("globalDangerous");
globalDangerousBox.checked = dangerousDefault();
globalDangerousBox.addEventListener("change", (e) => {
  localStorage.setItem("globalDangerous", e.target.checked ? "1" : "0");
});

document.getElementById("refreshBtn").addEventListener("click", loadSessions);
// global search button is hidden in index.html (feature not reliable yet) — guard the wiring
document.getElementById("globalSearchBtn")?.addEventListener("click", openGlobalSearchModal);

initThemeToggle();

// close card menus on outside click — except the Filter projects dropdown, which is meant to stay
// open across several checkbox clicks in a row (its own module-level state/rerender handles it)
document.addEventListener("click", (e) => {
  document.querySelectorAll(".bc-dropdown.open").forEach((d) => {
    if (d.classList.contains("project-filter-dropdown") && d.contains(e.target)) return;
    d.classList.remove("open");
  });
});

document.addEventListener("keydown", (e) => {
  const tag = document.activeElement?.tagName;
  const typing = tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
  if (e.key === "Escape") {
    if (document.getElementById("modalRoot").innerHTML.trim()) { closeModal(); return; }
    if (typing) document.activeElement.blur();
    return;
  }
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
    e.preventDefault();
    openCommandPalette();
    return;
  }
  if (typing) return;
  if (e.key === "/") {
    e.preventDefault();
    document.getElementById("search").focus();
  } else if (e.key === "n") {
    // only a saved view has a place to drop a new task into — the group lens's columns are locked
    // project columns, not a spot to add one-off work
    const view = currentSavedView();
    if (!view?.columns.length) return;
    e.preventDefault();
    openColumnTaskModal(view.columns[0].id, savedViewCtx(view)); // same New Task modal the column "+" opens
  }
});

document.getElementById("app").classList.add("board-mode"); // board is the only sessions view now
render();

// #sidebar's sticky offset reads this — the header's real height isn't a fixed constant (the
// toolbar can wrap on a narrow window), so it's measured live instead of hardcoded.
function updateHeaderHeightVar() {
  const h = document.querySelector("header")?.offsetHeight;
  if (h) document.documentElement.style.setProperty("--header-h", h + "px");
}
updateHeaderHeightVar();
// .board's sticky offset also depends on the toolbar's height (set per-render in
// renderBoardView.js) — a window resize can reflow/wrap its content without a re-render, so it
// needs its own recompute here too.
function updateToolbarHeightVar() {
  const h = document.querySelector(".board-sticky-toolbar")?.offsetHeight;
  if (h) document.documentElement.style.setProperty("--toolbar-h", h + "px");
}
window.addEventListener("resize", () => {
  updateHeaderHeightVar();
  updateToolbarHeightVar();
});

// Collapsing frees up board width for the kanban columns — persisted so it survives a reload.
const SIDEBAR_COLLAPSED_KEY = "sidebarCollapsed";
const sidebarEl = document.getElementById("sidebar");
const sidebarToggleBtn = document.getElementById("sidebarToggle");
function applySidebarCollapsed(collapsed) {
  sidebarEl.classList.toggle("collapsed", collapsed);
  sidebarToggleBtn.classList.toggle("collapsed-state", collapsed);
  sidebarToggleBtn.textContent = collapsed ? "›" : "‹";
  sidebarToggleBtn.title = collapsed ? "Expand sidebar" : "Collapse sidebar";
}
applySidebarCollapsed(localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === "1");
sidebarToggleBtn.addEventListener("click", () => {
  const next = !sidebarEl.classList.contains("collapsed");
  applySidebarCollapsed(next);
  localStorage.setItem(SIDEBAR_COLLAPSED_KEY, next ? "1" : "0");
});

wireTabs();

// initBoardStateFromLocation already set the view from the URL; loadSessions renders it (and, for a
// /views/<id> deep link, re-renders once savedViews arrive so the saved view resolves).
// The overlay only shows if this first load is actually slow (a big ~/.claude to scan) — the timer
// is cleared as soon as loading finishes, so a normal fast local load never flashes it at all.
const loadingOverlay = document.getElementById("loadingOverlay");
const showOverlayTimer = setTimeout(() => {
  loadingOverlay.style.display = "flex";
  document.getElementById("appShell").classList.add("loading-active");
}, 350);
loadSessions().finally(() => {
  clearTimeout(showOverlayTimer);
  loadingOverlay.style.display = "none";
  document.getElementById("appShell").classList.remove("loading-active");
});
initLiveUpdates(); // SSE — pushes a granular refetch within tens of ms of a real change (api/sse.js)
// Slow backstop only — SSE is the real-time path; this just covers the reconnect gap after e.g. a
// server restart. background:true so it never rebuilds under an open menu.
setInterval(() => loadSessions({ background: true }), 15000);
// Also refresh on tab-focus — a card's session id can go stale after /clear reconciles it
// server-side, and this is the only signal that a stale id might now be resumed.
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") loadSessions({ background: true });
});
window.addEventListener("focus", () => loadSessions({ background: true }));
// apply initial tab
if (currentTab === "todos") setTimeout(() => setTab("todos"), 0);
