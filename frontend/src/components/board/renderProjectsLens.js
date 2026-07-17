// "Projects" — a read-only lens computed live from each session's actual cwd, always in sync (no
// drag/manage-columns; nothing here is tagged, so it can never go stale). Clicking a project's
// name opens that project's own board — same navigation as clicking a project column on Main
// board or a project entry in the sidebar.
import { sessions } from "../../state.js";
import { escapeHtml, escapeAttr, projectName } from "../../ui/format.js";
import { boardCardHtml } from "../../subcomponents/boardCard.js";
import { wireBoardCards } from "./wireBoardCards.js";
import { enterProjectBoard } from "../../routing/boardRouting.js";

export function renderProjectsLens(filtered) {
  const app = document.getElementById("app");
  const cwds = [...new Set(filtered.filter((s) => !s.isTicket).map((s) => s.cwd))]
    .sort((a, b) => projectName(a).localeCompare(projectName(b)));

  if (!cwds.length) {
    app.innerHTML = '<div class="empty">No sessions match.</div>';
    return;
  }

  // preserve horizontal scroll position across re-renders (polling, search) — see renderBoardView.js
  const prevScrollLeft = app.querySelector(".board")?.scrollLeft || 0;

  app.innerHTML = `
    <div class="board">
      ${cwds.map((cwd) => {
        const items = filtered
          .filter((s) => s.cwd === cwd)
          .sort((a, b) => (b.running ? 1 : 0) - (a.running ? 1 : 0) || b.lastActive - a.lastActive);
        return `
          <div class="board-col" data-projects-lens-col="${escapeAttr(cwd)}">
            <div class="board-col-header">
              <span class="col-title-link" data-open-project="${escapeAttr(cwd)}" title="Open ${escapeAttr(projectName(cwd))}'s own board">${escapeHtml(projectName(cwd))}</span>
              <span class="board-count">${items.length}</span>
            </div>
            <div class="board-col-body">
              ${items.map(boardCardHtml).join("") || '<div class="empty" style="padding:16px 0;">No sessions</div>'}
            </div>
          </div>
        `;
      }).join("")}
    </div>
  `;

  const boardEl = app.querySelector(".board");
  if (boardEl) boardEl.scrollLeft = prevScrollLeft;

  wireBoardCards(app);
  app.querySelectorAll("[data-open-project]").forEach((el) => {
    el.addEventListener("click", (e) => {
      e.stopPropagation();
      enterProjectBoard(el.dataset.openProject);
    });
  });
}
