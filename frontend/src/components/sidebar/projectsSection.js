// Sidebar "Projects" section — click opens that project's own board; dragging a card onto a row
// tags it in (rejected if it belongs to a different project).
import { sessions, boardMode, activeProjectCwd } from "../../state.js";
import { escapeHtml, escapeAttr, projectName } from "../../ui/format.js";
import { enterProjectBoard, assignCardToProjectColumn } from "../../routing/boardRouting.js";

function projectCwds() {
  return [...new Set(sessions.filter((s) => !s.isTicket).map((s) => s.cwd))]
    .sort((a, b) => projectName(a).localeCompare(projectName(b)));
}

function projectRowHtml(cwd) {
  const count = sessions.filter((s) => !s.isTicket && s.cwd === cwd).length;
  const active = boardMode === "project" && activeProjectCwd === cwd;
  return `
    <div class="sidebar-item${active ? " active" : ""}" data-open-project="${escapeAttr(cwd)}" data-drop-project="${escapeAttr(cwd)}">
      <span class="sidebar-dot proj"></span>
      <span class="sidebar-label" title="${escapeAttr(cwd)}">${escapeHtml(projectName(cwd))}</span>
      <span class="sidebar-count">${count}</span>
    </div>
  `;
}

export function projectsSectionHtml() {
  const cwds = projectCwds();
  if (!cwds.length) return "";
  return `
    <div class="sidebar-group">Projects</div>
    ${cwds.map(projectRowHtml).join("")}
  `;
}

export function wireProjectsSection(root) {
  root.querySelectorAll("[data-open-project]").forEach((el) => {
    el.addEventListener("click", () => enterProjectBoard(el.dataset.openProject));

    el.addEventListener("dragover", (e) => {
      e.preventDefault();
      el.classList.add("dragover");
    });
    el.addEventListener("dragleave", () => el.classList.remove("dragover"));
    el.addEventListener("drop", async (e) => {
      e.preventDefault();
      el.classList.remove("dragover");
      const cardId = e.dataTransfer.getData("text/plain");
      if (!cardId || cardId.startsWith("row:")) return;
      await assignCardToProjectColumn(cardId, el.dataset.dropProject);
    });
  });
}
