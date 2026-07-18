// agentsDockHtml is currently unreachable (renderBoardView always gets '' back), but the wiring
// below is kept working in case it's re-enabled later.
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
