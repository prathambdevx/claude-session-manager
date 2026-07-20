// The "⋮ Manage columns" dropdown — reuses the same .bc-menu-wrap/.bc-dropdown language the card ⋮
// menus already use.
import { escapeHtml, escapeAttr } from "../../ui/format.js";
import { pushHistory } from "./boardUndo.js";
import { projectColorRank } from "../../ui/projectColors.js";

let menuOpen = false;

export function isManageColumnsMenuOpen() {
  return menuOpen;
}
export function closeManageColumnsMenu() {
  menuOpen = false;
}

// This dropdown is conditionally rendered, not class-toggled, so it needs its own outside-click
// close — registered once at module load, not per-render.
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

const EYE_ICON = `
  <svg class="icon-open" viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
    <path d="M1 8s2.7-4.6 7-4.6S15 8 15 8s-2.7 4.6-7 4.6S1 8 1 8Z" fill="none" stroke="currentColor" stroke-width="1.3"/>
    <circle cx="8" cy="8" r="2.1" fill="currentColor"/>
  </svg>
  <svg class="icon-closed" viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
    <path d="M2 7.6c1.6 2 3.9 3.1 6 3.1s4.4-1.1 6-3.1" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/>
    <path d="M8 10.7v1.7M4.6 9.7l-1.1 1.5M11.4 9.7l1.1 1.5" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/>
  </svg>
`;

function bulkToggleHtml(anyVisible, group) {
  return `
    <button class="mc-bulk-toggle ${anyVisible ? "on" : ""}" data-bulk-vis="${group}" title="${anyVisible ? "Hide every column in this section" : "Show every column in this section"}">
      ${EYE_ICON}
      <span>${anyVisible ? "Hide all" : "Show all"}</span>
    </button>`;
}

// Rows are built and wired separately from the initial HTML string above since they depend on
// `ctx.cols` at wiring time (columns can change between renders without a full board re-render).
// `locked` (every column in the "All Projects" group lens) shows 🔒 instead of a delete button.
function columnRowHtml(c, locked, lockedReason, displayTitle, shown) {
  const swatch = c.cwd
    ? `<span class="mc-swatch col-pill-${projectColorRank(c.cwd) ?? 1}"></span>`
    : `<span class="mc-custom-dot"></span>`;
  return `
    <div class="drow ${shown ? "" : "is-hidden"}" draggable="true" data-row-col-id="${c.id}">
      <span class="row-drag">⠿</span>
      ${swatch}
      <span class="lbl">${escapeHtml(displayTitle ?? c.title)}</span>
      ${c.cwd ? "" : `<span class="row-rename" data-rename-col="${c.id}" title="Rename &quot;${escapeHtml(c.title)}&quot;">✎</span>`}
      <span class="drow-spacer"></span>
      <button class="sw${shown ? " on" : ""}" data-toggle-hidden="${c.id}" title="${shown ? "Hide" : "Show"} this column"></button>
      ${locked
        ? `<span class="row-locked" title="${escapeAttr(lockedReason)}">🔒</span>`
        : `<button class="del-col" data-delete-col="${c.id}" title="Remove &quot;${escapeHtml(c.title)}&quot;">✕</button>`}
    </div>
  `;
}

// Reflects c.hidden onto its already-rendered row before the next full rerender() lands — a
// rerender can take a beat on a large board, so without this the flip would lag visibly behind the click.
function patchRowVisibility(dropdown, c) {
  const row = dropdown.querySelector(`[data-row-col-id="${c.id}"]`);
  row?.classList.toggle("is-hidden", c.hidden);
  const sw = row?.querySelector(".sw");
  if (sw) {
    sw.classList.toggle("on", !c.hidden);
    sw.title = `${c.hidden ? "Show" : "Hide"} this column`;
  }
}

// countFor(c)/displayTitleFor(c)/shownFor(c)/orderFor(cols) come from the caller
// (renderBoardView.js) — avoids duplicating its column-membership/visibility/ordering rules here,
// so the panel never disagrees with what's actually on the board.
export function wireManageColumnsPanel(root, ctx, { countFor, displayTitleFor, shownFor, orderFor, onRename, onDeleteColumn, onReorder, rerender }) {
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

  // In "All Projects" every column is a real project — draggable/hideable/renameable, but never
  // deletable (there's nothing to "add back" the way a plain custom column has).
  const isGroupLens = ctx.kind === "group";
  const orderedCols = orderFor ? orderFor(ctx.cols) : ctx.cols;
  const rowsOf = (cols) => cols.map((c) => ({ c, shown: shownFor ? shownFor(c) : !c.hidden }));
  // Grouped separately (project columns vs. your own) so it's immediately clear which are fixed
  // by Filter projects and which are freely yours to rename/delete.
  const projectRows = rowsOf(orderedCols.filter((c) => c.cwd));
  const customRows = rowsOf(orderedCols.filter((c) => !c.cwd));

  const renderSection = (label, rows, group) => {
    if (!rows.length) return;
    const section = document.createElement("div");
    section.className = "mc-section";
    const anyVisible = rows.some((r) => r.shown);
    section.innerHTML = `<div class="mc-section-label">${escapeHtml(label)}${bulkToggleHtml(anyVisible, group)}</div>`;
    dropdown.appendChild(section);
    for (const { c, shown } of rows) {
      const row = document.createElement("div");
      row.innerHTML = columnRowHtml(
        c, isGroupLens,
        "Project columns can be renamed, reordered, and hidden — but not deleted",
        displayTitleFor?.(c), shown,
      );
      dropdown.appendChild(row.firstElementChild);
    }
  };
  renderSection("Project columns", projectRows, "project");
  renderSection("Your columns", customRows, "custom");
  if (!projectRows.length && !customRows.length) {
    dropdown.innerHTML += `<div class="drow"><span class="quiet">No columns yet.</span></div>`;
  }

  dropdown.querySelectorAll("[data-toggle-hidden]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const c = ctx.cols.find((x) => x.id === btn.dataset.toggleHidden);
      if (!c) return;
      pushHistory(ctx);
      c.hidden = !c.hidden;
      ctx.save();
      menuOpen = true;
      patchRowVisibility(dropdown, c);
      rerender();
    });
  });

  // Tapping anywhere on the row does the same thing as its .sw switch — excluded elements have
  // their own job (rename, delete, drag) and would otherwise fight this for the click.
  dropdown.querySelectorAll(".drow[data-row-col-id]").forEach((row) => {
    row.addEventListener("click", (e) => {
      if (e.target.closest(".row-rename, .del-col, .row-locked, .row-drag, .sw")) return;
      row.querySelector("[data-toggle-hidden]")?.click();
    });
  });

  // Bulk hide/show for one whole section — flips by current aggregate state, same as the board's
  // own "« Collapse all / » Expand all" button, just scoped to this section's columns.
  dropdown.querySelectorAll("[data-bulk-vis]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const group = btn.dataset.bulkVis;
      const rows = group === "project" ? projectRows : customRows;
      const anyVisible = rows.some((r) => r.shown);
      pushHistory(ctx);
      // ctx.cols re-resolves the view by id on every access (a poll can swap savedViews for fresh
      // objects between renders) — re-fetch it now and mutate THESE objects, not the ones captured
      // in `rows` at panel-mount time, or the flip silently no-ops once that swap has happened.
      const ids = new Set(rows.map((r) => r.c.id));
      const freshCols = ctx.cols.filter((c) => ids.has(c.id));
      for (const c of freshCols) c.hidden = anyVisible;
      ctx.save();
      menuOpen = true;
      for (const c of freshCols) patchRowVisibility(dropdown, c);
      const nowAnyVisible = !anyVisible;
      btn.classList.toggle("on", nowAnyVisible);
      btn.title = nowAnyVisible ? "Hide every column in this section" : "Show every column in this section";
      const label = btn.querySelector("span");
      if (label) label.textContent = nowAnyVisible ? "Hide all" : "Show all";
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
