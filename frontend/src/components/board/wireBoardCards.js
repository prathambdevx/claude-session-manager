// Card action wiring shared by renderBoardView (main/per-project boards) and any other place a
// board-card's markup gets inserted — click actions, double-click-to-resume, and the 3-dot menu.
import { sessions, dismissDoneChip } from "../../state.js";
import { resumeSession, deleteSession, closeSessionTerminal, summarizeSession, patchMeta, loadSessions } from "../../api/sessionsApi.js";
import { openReviewModal } from "../modals/reviewModal.js";
import { openExtractModal } from "../modals/extractModal.js";
import { openRenameModal } from "../modals/renameModal.js";
import { convertTicketToSession } from "../modals/columnTaskModal.js";
import { openPromptModal } from "../../ui/promptModal.js";
import { openQuickPromptModal } from "../modals/quickPromptModal.js";
import { dismissQuickPrompt } from "../../api/quickPromptsApi.js";
import { wireTooltips } from "../../ui/tooltip.js";

export function wireBoardCards(app) {
  wireTooltips(app);
  app.querySelectorAll("[data-action]").forEach((el) => {
    el.addEventListener("click", async (e) => {
      e.stopPropagation();
      // stopPropagation above skips main.js's outside-click handler that normally closes an open
      // ⋮ menu — without this, a confirm modal (Close terminal/Delete) opens with the menu still
      // showing behind/over it.
      document.querySelectorAll(".bc-dropdown.open").forEach((d) => d.classList.remove("open"));
      const { action, id } = el.dataset;
      const s = sessions.find((x) => x.id === id);
      const title = s?.meta?.name || s?.firstMessage || id;
      if (action === "resume") resumeSession(id, false);
      if (action === "fork") resumeSession(id, true);
      if (action === "delete") deleteSession(id, title);
      if (action === "closeTerminal") closeSessionTerminal(id, title);
      if (action === "review") openReviewModal(id);
      if (action === "extract") openExtractModal(id);
      if (action === "summarize") summarizeSession(id);
      if (action === "ticket-done") patchMeta(id, { status: s?.meta?.status === "done" ? null : "done" });
      if (action === "ticket-convert") convertTicketToSession(id);
      if (action === "quickprompt") openQuickPromptModal(id);
      if (action === "quickjob-dismiss") { await dismissQuickPrompt(id); await loadSessions(); }
      if (action === "donechip-dismiss") {
        dismissDoneChip(id, s?.lastActivity);
        await import("../../pages/sessionsPage.js").then((m) => m.render());
      }
      if (action === "rename") {
        openRenameModal(id, s?.meta?.name, s?.isTicket ? "Rename ticket" : "Rename session");
      }
      if (action === "editDesc") {
        const next = await openPromptModal({ title: "Edit description", value: s?.meta?.description || "" });
        // `undefined` is silently dropped by JSON.stringify — sending it here would leave the old
        // description untouched server-side (the merge in the meta route just wouldn't see the
        // key), so clearing it back to "no description" must send an explicit `null` instead.
        if (next !== null) patchMeta(id, { description: next.trim() || null, descriptionSource: next.trim() ? "manual" : null });
      }
    });
  });

  // double-click on board card to resume session
  app.querySelectorAll(".board-card[data-card-id]").forEach((card) => {
    card.addEventListener("dblclick", (e) => {
      if (e.target.closest(".bc-menu-wrap") || e.target.closest("button")) return;
      const id = card.dataset.cardId;
      const s = sessions.find((x) => x.id === id);
      if (s?.isTicket) return;
      resumeSession(id, false);
    });
  });

  // three-dot menu toggle
  app.querySelectorAll("[data-menu-toggle]").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const id = btn.dataset.menuToggle;
      const dropdown = document.getElementById("menu-" + id);
      const wasOpen = dropdown.classList.contains("open");
      document.querySelectorAll(".bc-dropdown.open").forEach((d) => d.classList.remove("open"));
      if (!wasOpen) {
        const rect = btn.getBoundingClientRect();
        const spaceBelow = window.innerHeight - rect.bottom;
        dropdown.style.left = "";
        dropdown.style.right = (window.innerWidth - rect.right) + "px";
        if (spaceBelow < 200) {
          dropdown.style.top = "";
          dropdown.style.bottom = (window.innerHeight - rect.top) + "px";
        } else {
          dropdown.style.top = rect.bottom + 4 + "px";
          dropdown.style.bottom = "";
        }
        dropdown.classList.add("open");
      }
    });
  });
}
