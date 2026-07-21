// Top-level dispatcher: All Projects vs. a saved view, and holds the toolbar-driven
// search/date filtering that both share.
import { sessions, contentMatchIds, activeView, sessionsLoaded, tmuxAvailable } from "../state.js";
import { groupBoardCtx, savedViewCtx, switchToView, currentSavedView } from "../routing/boardRouting.js";
import { renderBoardView } from "../components/board/renderBoardView.js";
import { renderSidebar } from "../components/sidebar/renderSidebar.js";
import { toast } from "../ui/toast.js";

// True while an open ⋮ dropdown, rename input, or Views callout exists — background refreshers skip the rebuild until it closes.
export function isTransientUiOpen() {
  return !!document.querySelector(".bc-dropdown.open, [data-rename-col-input], .views-callout.show");
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
  // surfaced instead of the bare 500s every terminal action would otherwise throw with tmux missing
  document.getElementById("tmuxBanner").style.display = tmuxAvailable ? "none" : "";
  const q = document.getElementById("search").value.trim();

  const dateFilter = document.getElementById("filterDate").value;
  const dateCutoff = dateFilter ? Date.now() - Number(dateFilter) * 86400000 : null;

  const filtered = sessions.filter((s) => {
    if (dateCutoff && s.lastActive < dateCutoff) return false;
    return matchesSearch(s, q);
  });

  document.getElementById("statLine").textContent =
    `${filtered.length} session${filtered.length === 1 ? "" : "s"} shown · ${sessions.filter(s => s.running).length} currently running`;

  if (activeView === "group") { renderBoardView(filtered.filter((s) => !s.isTicket), groupBoardCtx()); return; }

  const view = currentSavedView();
  if (!view) {
    // see sessionsLoaded in state.js — a miss only means "really deleted" once real data has arrived
    if (sessionsLoaded) {
      toast("That view was deleted.");
      switchToView("group");
    }
    return;
  }
  renderBoardView(filtered, savedViewCtx(view));
}
