// ⌘K / Ctrl+K — a filterable jump list over views (Main board, Projects lens, saved views) and
// projects. Bound in main.js; deliberately not "/" since that's already the search-focus shortcut.
import { sessions, savedViews } from "../../state.js";
import { escapeHtml, projectName } from "../../ui/format.js";
import { modalShell, closeReviewModal } from "../../ui/modalShell.js";
import { switchToView } from "../sidebar/viewsSection.js";
import { enterProjectBoard } from "../../routing/boardRouting.js";

function entries() {
  const cwds = [...new Set(sessions.filter((s) => !s.isTicket).map((s) => s.cwd))]
    .sort((a, b) => projectName(a).localeCompare(projectName(b)));
  return [
    { group: "Views", label: "Main board", go: () => switchToView("main") },
    { group: "Views", label: "Projects", go: () => switchToView("group") },
    ...savedViews.map((v) => ({ group: "Views", label: v.title, go: () => switchToView(`saved:${v.id}`) })),
    ...cwds.map((cwd) => ({ group: "Projects", label: projectName(cwd), go: () => enterProjectBoard(cwd) })),
  ];
}

export function openCommandPalette() {
  modalShell(`
    <input id="cpInput" class="notes-input" placeholder="Jump to a view or project…" autocomplete="off" />
    <div id="cpList" class="cp-list"></div>
  `, 480);

  const input = document.getElementById("cpInput");
  const list = document.getElementById("cpList");
  let items = entries();
  let selected = 0;

  const go = (item) => { closeReviewModal(); item.go(); };

  const renderList = () => {
    if (!items.length) { list.innerHTML = '<div class="empty">No matches</div>'; return; }
    let lastGroup = null;
    list.innerHTML = items.map((item, i) => {
      const header = item.group !== lastGroup ? `<div class="cp-group">${escapeHtml(item.group)}</div>` : "";
      lastGroup = item.group;
      return `${header}<div class="cp-item${i === selected ? " sel" : ""}" data-cp-index="${i}">${escapeHtml(item.label)}</div>`;
    }).join("");
    list.querySelectorAll("[data-cp-index]").forEach((el) => {
      el.addEventListener("mouseenter", () => { selected = Number(el.dataset.cpIndex); renderList(); });
      el.addEventListener("click", () => go(items[Number(el.dataset.cpIndex)]));
    });
  };

  input.addEventListener("input", () => {
    const q = input.value.trim().toLowerCase();
    items = entries().filter((item) => item.label.toLowerCase().includes(q));
    selected = 0;
    renderList();
  });

  input.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown") { e.preventDefault(); selected = Math.min(selected + 1, items.length - 1); renderList(); }
    if (e.key === "ArrowUp") { e.preventDefault(); selected = Math.max(selected - 1, 0); renderList(); }
    if (e.key === "Enter") { e.preventDefault(); if (items[selected]) go(items[selected]); }
  });

  renderList();
  input.focus();
}
