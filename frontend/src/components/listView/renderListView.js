import { sessions, collapsedProjects, expandedCards } from "../../state.js";
import { escapeHtml, escapeAttr, projectName } from "../../ui/format.js";
import { cardHtml } from "../../subcomponents/listCard.js";
import { resumeSession, copyCommand, deleteSession, patchMeta, summarizeSession } from "../../api/sessionsApi.js";
import { openReviewModal } from "../modals/reviewModal.js";
import { openExtractModal } from "../modals/extractModal.js";
import { openRenameModal } from "../modals/renameModal.js";
import { convertTicketToSession } from "../modals/columnTaskModal.js";

export function toggleDetails(id) {
  if (expandedCards.has(id)) expandedCards.delete(id);
  else expandedCards.add(id);
  import("../../pages/sessionsPage.js").then((m) => m.render());
}

export function renderListView(filtered, sortMode) {
  // group by cwd
  const groups = new Map();
  for (const s of filtered) {
    const key = s.cwd;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(s);
  }

  // running sessions win ties (you're interacting with them right now); then most-recent mtime
  const byRecency = (a, b) => (b.running ? 1 : 0) - (a.running ? 1 : 0) || b.lastActive - a.lastActive;
  const sortFns = {
    recent: byRecency,
    oldest: (a, b) => a.lastActive - b.lastActive,
    messages: (a, b) => b.messageCount - a.messageCount,
    project: (a, b) => a.cwd.localeCompare(b.cwd),
  };
  for (const arr of groups.values()) arr.sort(sortFns[sortMode]);

  let projectEntries = [...groups.entries()];
  if (sortMode === "project") {
    projectEntries.sort((a, b) => a[0].localeCompare(b[0]));
  } else {
    // order groups by their most-recent session
    projectEntries.sort((a, b) => Math.max(...b[1].map(s => s.lastActive)) - Math.max(...a[1].map(s => s.lastActive)));
  }

  const app = document.getElementById("app");
  if (!projectEntries.length) {
    app.innerHTML = '<div class="empty">No sessions match.</div>';
    return;
  }

  app.innerHTML = projectEntries.map(([cwd, list]) => {
    const collapsed = collapsedProjects.has(cwd);
    const pinnedCount = list.filter(s => s.meta?.pinned).length;
    list.sort((a, b) => (b.meta?.pinned ? 1 : 0) - (a.meta?.pinned ? 1 : 0));
    return `
      <div class="project-group">
        <div class="project-header ${collapsed ? "collapsed" : ""}" data-cwd="${escapeAttr(cwd)}">
          <span class="chev">▾</span>
          <span>${escapeHtml(projectName(cwd))}</span>
          <span class="count">— ${escapeHtml(cwd)} · ${list.length} session${list.length === 1 ? "" : "s"}${pinnedCount ? " · " + pinnedCount + " pinned" : ""}</span>
        </div>
        <div class="cards ${collapsed ? "collapsed" : ""}">
          ${list.map(cardHtml).join("")}
        </div>
      </div>
    `;
  }).join("");

  const rerender = () => import("../../pages/sessionsPage.js").then((m) => m.render());

  app.querySelectorAll(".project-header").forEach((el) => {
    el.addEventListener("click", () => {
      const cwd = el.dataset.cwd;
      if (collapsedProjects.has(cwd)) collapsedProjects.delete(cwd);
      else collapsedProjects.add(cwd);
      localStorage.setItem("collapsedProjects", JSON.stringify([...collapsedProjects]));
      rerender();
    });
  });

  app.querySelectorAll("[data-action]").forEach((el) => {
    el.addEventListener("click", (e) => {
      e.stopPropagation();
      const { action, id } = el.dataset;
      const s = sessions.find(x => x.id === id);
      const title = s?.meta?.name || s?.firstMessage || id;
      if (action === "resume") resumeSession(id, false);
      if (action === "fork") resumeSession(id, true);
      if (action === "copy") copyCommand(id, false);
      if (action === "delete") deleteSession(id, title);
      if (action === "pin") patchMeta(id, { pinned: !s.meta?.pinned });
      if (action === "toggleDetails") { toggleDetails(id); }
      if (action === "summarize") summarizeSession(id);
      if (action === "review") openReviewModal(id);
      if (action === "extract") openExtractModal(id);
      if (action === "ticket-done") patchMeta(id, { status: s?.meta?.status === "done" ? undefined : "done" });
      if (action === "ticket-convert") convertTicketToSession(id);
      if (action === "rename") {
        openRenameModal(id, s?.meta?.name, "Rename ticket");
      }
      if (action === "rename-focus") {
        const input = app.querySelector(`input[data-name-edit="${id}"]`);
        if (input) { input.focus(); input.select(); }
      }
    });
  });

  app.querySelectorAll("[data-name-edit]").forEach((el) => {
    el.addEventListener("blur", () => patchMeta(el.dataset.nameEdit, { name: el.value.trim() || undefined }));
    el.addEventListener("keydown", (e) => { if (e.key === "Enter") el.blur(); });
  });
  app.querySelectorAll("[data-description-edit]").forEach((el) => {
    el.addEventListener("blur", () => {
      const val = el.value.trim();
      patchMeta(el.dataset.descriptionEdit, { description: val || undefined, descriptionSource: val ? "manual" : undefined });
    });
    el.addEventListener("keydown", (e) => { if (e.key === "Enter") el.blur(); });
  });
  app.querySelectorAll("[data-tags-edit]").forEach((el) => {
    el.addEventListener("blur", () => {
      const tags = el.value.split(",").map(t => t.trim()).filter(Boolean);
      patchMeta(el.dataset.tagsEdit, { tags });
    });
    el.addEventListener("keydown", (e) => { if (e.key === "Enter") el.blur(); });
  });
  app.querySelectorAll("[data-notes-edit]").forEach((el) => {
    el.addEventListener("blur", () => patchMeta(el.dataset.notesEdit, { notes: el.value.trim() || undefined }));
  });
}
