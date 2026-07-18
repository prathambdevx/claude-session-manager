// Entry point — replicates the original monolithic app.js's exact effective bootstrap order:
// 1) synchronously derive board routing state from the URL (must happen before the first
//    render()/loadSessions() call), 2) wire every remaining top-level DOM control, 3) run the
// original end-of-file init sequence (load data, start polling, restore the active tab).
import { currentTab, contentSearchTimer, setContentSearchTimer, boardColumns, defaultViewId, setActiveView } from "./state.js";
import { initBoardStateFromLocation, wirePopstate } from "./routing/boardRouting.js";
import { loadSessions, loadProjects, fetchContentMatches } from "./api/sessionsApi.js";
import { initLiveUpdates } from "./api/sse.js";
import { dangerousDefault } from "./ui/formFragments.js";
import { render } from "./pages/sessionsPage.js";
import { setTab, wireTabs } from "./pages/todosPage.js";
import { renderTodoBoard } from "./components/todoBoard/renderTodoBoard.js";
import { openGlobalSearchModal } from "./components/modals/globalSearchModal.js";
import { openColumnTaskModal } from "./components/modals/columnTaskModal.js";
import { openCommandPalette } from "./components/commandPalette/commandPalette.js";
import { mainBoardCtx } from "./routing/boardRouting.js";
import { closeReviewModal } from "./ui/modalShell.js";
import { initThemeToggle } from "./components/theme/themeToggle.js";
import { boardMode } from "./state.js";

initBoardStateFromLocation();
wirePopstate();

document.getElementById("search").addEventListener("input", (e) => {
  if (currentTab === "todos") { renderTodoBoard(); return; }
  render();
  clearTimeout(contentSearchTimer);
  setContentSearchTimer(setTimeout(() => fetchContentMatches(e.target.value), 350));
});

document.getElementById("filterDate").addEventListener("change", render);
document.getElementById("filterProject").addEventListener("change", render);

const globalDangerousBox = document.getElementById("globalDangerous");
globalDangerousBox.checked = dangerousDefault();
globalDangerousBox.addEventListener("change", (e) => {
  localStorage.setItem("globalDangerous", e.target.checked ? "1" : "0");
});

document.getElementById("refreshBtn").addEventListener("click", loadSessions);
document.getElementById("globalSearchBtn").addEventListener("click", openGlobalSearchModal);

initThemeToggle();

// close card menus on outside click
document.addEventListener("click", () => {
  document.querySelectorAll(".bc-dropdown.open").forEach((d) => d.classList.remove("open"));
});

document.addEventListener("keydown", (e) => {
  const tag = document.activeElement?.tagName;
  const typing = tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
  if (e.key === "Escape") {
    if (document.getElementById("modalRoot").innerHTML.trim()) { closeReviewModal(); return; }
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
    if (boardMode !== "main") return; // global shortcut only targets the main board, not a drilled-in project board
    e.preventDefault();
    openColumnTaskModal(boardColumns[0]?.id, mainBoardCtx()); // same New Task modal the column "+" opens
  }
});

document.getElementById("app").classList.add("board-mode"); // board is the only sessions view now
render();

wireTabs();

loadSessions().then(() => {
  // Apply the saved "default view" star exactly once at boot, and only when landing on the bare
  // Main board URL — never on a direct/reloaded link into a specific project's own board, and
  // never on later polls (those must never yank the user back to a different view mid-use).
  if (boardMode === "main" && defaultViewId && defaultViewId !== "main") {
    setActiveView(defaultViewId);
    render();
  }
});
loadProjects();
initLiveUpdates(); // SSE — pushes a granular refetch within tens of ms of a real change (api/sse.js)
// Slow backstop only — SSE (above) is the real-time path. This exists purely for the gap where the
// live-update connection is briefly down (most commonly a server restart: EventSource auto-
// reconnects, but a change during the reconnect gap would otherwise be missed) so the board reaches
// consistency on its own within a few seconds. 1s would be pointless churn given SSE; 15s is plenty
// as a safety net. `background: true` so it never rebuilds the board out from under an open menu.
setInterval(() => loadSessions({ background: true }), 15000);
// Also refresh the moment you return to this tab/window — a card's embedded session id can be stale
// otherwise. That staleness is exactly what let a real bug through: open a session, /clear it
// (server-side reconciliation swaps which id owns that card), close the terminal, then immediately
// re-click the SAME still-stale card before the next refresh — resuming the OLD pre-clear id
// instead of the one that now lives there. Closing a terminal and clicking back is a focus change.
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") loadSessions({ background: true });
});
window.addEventListener("focus", () => loadSessions({ background: true }));
// apply initial tab
if (currentTab === "todos") setTimeout(() => setTab("todos"), 0);
