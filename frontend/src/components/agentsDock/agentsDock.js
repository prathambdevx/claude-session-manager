// Moved as-is (not deleted) in case it's re-enabled later — agentsDockHtml is currently
// unreachable (renderBoardView always gets '' back), but the wiring is kept working.
//
// function agentsDockHtml() {
//   const collapsed = localStorage.getItem("agentsDockCollapsed") === "1";
//   const recent = delegations.slice(0, 8);
//   const jobChip = (d) => {
//     const icon = d.status === "done" ? "✓" : d.status === "error" ? "✗" : "⏳";
//     const cls = d.status === "done" ? "job-done" : d.status === "error" ? "job-error" : "job-running";
//     return `<span class="job-chip ${cls}" data-open-delegation="${d.id}" title="${escapeAttr(d.agentName + " → " + d.sessionLabel)} — click for details">
//       ${icon} ${escapeHtml(d.agentEmoji)} ${escapeHtml(d.sessionLabel.slice(0, 24))}</span>`;
//   };
//   return `
//     <div class="agents-dock ${collapsed ? "collapsed" : ""}" id="agentsDock">
//       <div class="dock-row">
//         <span class="dock-label" id="agentsDockToggle" title="Collapse/expand">AGENTS ${collapsed ? "▸" : "▾"}</span>
//         ${agents
//           .map(
//             (a) => `<div class="agent-tile" data-agent-drop="${a.id}" data-agent-edit="${a.id}" title="${escapeAttr(a.prompt.slice(0, 120))} — drop a session to delegate; click to edit">
//               <span>${escapeHtml(a.emoji)}</span> <span>${escapeHtml(a.name)}</span>
//               <span class="agent-perm ${a.permission === "edit" ? "perm-edit" : "perm-ro"}">${a.permission === "edit" ? "✎" : "👁"}</span>
//             </div>`
//           )
//           .join("")}
//         <div class="agent-tile agent-new" id="agentNewTile" title="Create a new agent">＋ New agent</div>
//       </div>
//       <div class="dock-row dock-jobs">
//         <span class="dock-label">JOBS</span>
//         ${recent.length ? recent.map(jobChip).join("") : '<span class="dock-empty">no delegations yet — drop a session on an agent</span>'}
//         <a class="dock-all" href="/delegations" target="_blank" rel="noopener">all ↗</a>
//       </div>
//     </div>
//   `;
// }
import { sessions } from "../../state.js";
import { toast } from "../../ui/toast.js";
import { startDelegation } from "../../api/sessionsApi.js";
import { openAgentModal } from "../modals/agentModal.js";
import { openDelegationModal } from "../modals/delegationModal.js";

export function agentsDockHtml() { return ''; }

export function wireAgentsDock(app) {
  const dock = app.querySelector("#agentsDock");
  if (!dock) return;

  app.querySelector("#agentsDockToggle")?.addEventListener("click", () => {
    const now = !dock.classList.contains("collapsed");
    localStorage.setItem("agentsDockCollapsed", now ? "1" : "0");
    import("../../pages/sessionsPage.js").then((m) => m.render());
  });

  app.querySelector("#agentNewTile")?.addEventListener("click", () => openAgentModal(null));

  app.querySelectorAll("[data-agent-edit]").forEach((el) => {
    el.addEventListener("click", (e) => {
      // ignore clicks that are actually the start of a drag-drop target interaction
      if (e.defaultPrevented) return;
      openAgentModal(el.dataset.agentEdit);
    });
  });

  app.querySelectorAll("[data-open-delegation]").forEach((el) => {
    el.addEventListener("click", () => openDelegationModal(el.dataset.openDelegation));
  });

  // each agent tile is a drop target — dropping a session delegates it to that agent
  app.querySelectorAll("[data-agent-drop]").forEach((tile) => {
    tile.addEventListener("dragover", (e) => {
      e.preventDefault();
      tile.classList.add("dragover");
    });
    tile.addEventListener("dragleave", () => tile.classList.remove("dragover"));
    tile.addEventListener("drop", (e) => {
      e.preventDefault();
      tile.classList.remove("dragover");
      const payload = e.dataTransfer.getData("text/plain");
      if (!payload.startsWith("card:")) return;
      const sessionId = payload.slice(5);
      const s = sessions.find((x) => x.id === sessionId);
      if (s?.isTicket) { toast("Tickets can't be delegated — start a session from it first"); return; }
      startDelegation(tile.dataset.agentDrop, sessionId);
    });
  });
}
