// The "⋮ Manage columns" dropdown — auto-hide-empty toggle, one row per column (drag handle,
// visibility switch, rename pencil, delete), reusing the same .bc-menu-wrap/.bc-dropdown
// language the card ⋮ menus already use elsewhere.
import { autoHideEmpty } from "../../state.js";
import { escapeHtml } from "../../ui/format.js";
import { toast } from "../../ui/toast.js";
import { saveAutoHideEmpty } from "../../api/boardSettingsApi.js";
import { pushHistory } from "./boardUndo.js";

let menuOpen = false;

export function isManageColumnsMenuOpen() {
  return menuOpen;
}
export function closeManageColumnsMenu() {
  menuOpen = false;
}

// Unlike the card ⋮ menus (a JS-positioned `.open` class closed by a single shared listener in
// main.js), this dropdown is conditionally rendered rather than class-toggled (see
// manageColumnsDropdownHtml below), so it needs its own outside-click close — registered once here
// at module load, not per-render, so it never accumulates listeners across the app's polling.
document.addEventListener("click", (e) => {
  if (!menuOpen) return;
  const wrap = document.querySelector(".manage-columns-dropdown");
  const toggle = document.querySelector("[data-manage-columns-toggle]");
  if (wrap?.contains(e.target) || toggle?.contains(e.target)) return;
  menuOpen = false;
  import("../../pages/sessionsPage.js").then((m) => m.render());
});

export function manageColumnsButtonHtml() {
  return `
    <div class="bc-menu-wrap">
      <button class="btn" data-manage-columns-toggle title="Hide, reorder, rename, or delete columns">⋮ Manage columns</button>
      ${menuOpen ? manageColumnsDropdownHtml() : ""}
    </div>
  `;
}

function manageColumnsDropdownHtml() {
  return `<div class="bc-dropdown manage-columns-dropdown" id="manageColumnsDropdown"></div>`;
}

// A column can be invisible on the board for two different reasons — manually hidden (`c.hidden`),
// or swept out by "auto-hide empty columns" because it's currently empty — but the switch and its
// click behavior need to treat both as one "is this column currently shown?" state.
function isAutoHidden(c, count, isHome) {
  return autoHideEmpty && !isHome && count === 0 && !c.neverPopulated && !c.hidden;
}

// Rows are built and wired separately from the initial HTML string above since they depend on
// `ctx.cols` at wiring time (columns can change between renders without a full board re-render).
function columnRowHtml(c, count, isHome) {
  const autoHidden = isAutoHidden(c, count, isHome);
  const shown = !c.hidden && !autoHidden;
  return `
    <div class="drow" draggable="true" data-row-col-id="${c.id}">
      <span class="row-drag">⠿</span>
      <button class="sw${shown ? " on" : ""}" data-toggle-hidden="${c.id}" title="${shown ? "Hide" : "Show"} this column"></button>
      <span class="lbl">${escapeHtml(c.title)}</span>
      ${autoHidden ? '<span class="quiet">auto-hidden</span>' : ""}
      <span class="row-rename" data-rename-col="${c.id}" title="Rename &quot;${escapeHtml(c.title)}&quot;">✎</span>
      ${isHome
        ? `<span class="row-locked" title="The home column always shows every session — it can be hidden but never deleted">🔒</span>`
        : `<button class="del-col" data-delete-col="${c.id}" title="Remove &quot;${escapeHtml(c.title)}&quot;">✕</button>`}
    </div>
  `;
}

// `countFor(c)` comes from the caller (renderBoardView.js) since it already knows how to compute
// a column's members (permanent project membership vs. plain tag) — avoids duplicating that rule
// here.
export function wireManageColumnsPanel(root, ctx, { countFor, onRename, onDeleteColumn, onReorder, rerender }) {
  const toggleBtn = root.querySelector("[data-manage-columns-toggle]");
  toggleBtn?.addEventListener("click", (e) => {
    e.stopPropagation();
    menuOpen = !menuOpen;
    rerender();
  });
  if (!menuOpen) return;

  const dropdown = root.querySelector("#manageColumnsDropdown");
  if (!dropdown) return;
  dropdown.addEventListener("click", (e) => e.stopPropagation());

  const ruleRow = document.createElement("div");
  ruleRow.className = "drow rule";
  ruleRow.innerHTML = `<button class="sw${autoHideEmpty ? " on" : ""}" data-toggle-auto-hide></button><span class="lbl">Auto-hide empty columns</span>`;
  dropdown.appendChild(ruleRow);
  ruleRow.querySelector("[data-toggle-auto-hide]").addEventListener("click", async () => {
    await saveAutoHideEmpty(!autoHideEmpty);
    // a column stays visible while empty until this setting is actively re-toggled — flipping it
    // (either direction) re-evaluates every column fresh, so "stay visible while new/empty" isn't
    // permanent, but it's also never silent: it only ever changes right when you touch this switch
    for (const c of ctx.cols) delete c.neverPopulated;
    toast(autoHideEmpty ? "Empty columns will hide automatically" : "Auto-hide turned off");
    menuOpen = true;
    rerender();
  });

  ctx.cols.forEach((c, i) => {
    const row = document.createElement("div");
    row.innerHTML = columnRowHtml(c, countFor(c), i === 0);
    dropdown.appendChild(row.firstElementChild);
  });

  dropdown.querySelectorAll("[data-toggle-hidden]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const c = ctx.cols.find((x) => x.id === btn.dataset.toggleHidden);
      if (!c) return;
      pushHistory(ctx);
      const isHome = c === ctx.cols[0];
      if (c.hidden) {
        c.hidden = false; // manually hidden -> show
      } else if (isAutoHidden(c, countFor(c), isHome)) {
        c.neverPopulated = true; // only auto-hidden for being empty -> exempt it, show it
      } else {
        c.hidden = true; // currently shown -> hide it
      }
      ctx.save();
      menuOpen = true;
      rerender();
    });
  });

  dropdown.querySelectorAll("[data-rename-col]").forEach((el) => {
    el.addEventListener("click", () => { menuOpen = false; onRename(el.dataset.renameCol); });
  });

  dropdown.querySelectorAll("[data-delete-col]").forEach((btn) => {
    btn.addEventListener("click", () => { menuOpen = true; onDeleteColumn(btn.dataset.deleteCol); });
  });

  // drag-reorder rows within the list — a second way to reorder columns besides dragging their
  // headers directly on the board, useful once a column is hidden and can't be dragged there
  dropdown.querySelectorAll(".drow[data-row-col-id]").forEach((row) => {
    row.addEventListener("dragstart", (e) => {
      e.stopPropagation();
      e.dataTransfer.setData("text/plain", "row:" + row.dataset.rowColId);
      row.classList.add("dragging-row");
    });
    row.addEventListener("dragend", () => row.classList.remove("dragging-row"));
    row.addEventListener("dragover", (e) => { e.preventDefault(); row.classList.add("dragover-row"); });
    row.addEventListener("dragleave", () => row.classList.remove("dragover-row"));
    row.addEventListener("drop", (e) => {
      e.preventDefault();
      e.stopPropagation();
      row.classList.remove("dragover-row");
      const payload = e.dataTransfer.getData("text/plain");
      if (!payload.startsWith("row:")) return;
      const draggedId = payload.slice(4);
      const toId = row.dataset.rowColId;
      if (draggedId === toId) return;
      onReorder(draggedId, toId);
      menuOpen = true;
    });
  });
}
