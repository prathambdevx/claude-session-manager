import { sessions, savedViews } from "../../state.js";
import { escapeHtml, projectName } from "../../ui/format.js";
import { boardTagFor, projectRecency, projectColumnId } from "../../routing/boardRouting.js";
import { renameSavedView } from "../../api/savedViewsApi.js";
import { projectColorRank } from "../../ui/projectColors.js";
import { boardCardHtml } from "../../subcomponents/boardCard.js";
import { wireBoardCards } from "./wireBoardCards.js";
import { agentsDockHtml, wireAgentsDock } from "../agentsDock/agentsDock.js";
import { openColumnTaskModal } from "../modals/columnTaskModal.js";
import { pushHistory, hasHistoryFor, undoLast } from "./boardUndo.js";
import { manageColumnsButtonHtml, wireManageColumnsPanel, isManageColumnsMenuOpen } from "./manageColumnsPanel.js";
import { toast } from "../../ui/toast.js";
import { wireBoardDragDrop, reorderColumns } from "./wireBoardDragDrop.js";

// New-task glyph — an SVG cross instead of a text "+" so stroke weight stays crisp and
// consistent at any size, independent of font rendering.
const PLUS_ICON = `<svg width="14" height="14" viewBox="0 0 14 14" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><path d="M7 1v12M1 7h12" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>`;

// Membership is computed, not bucketed: a .cwd column shows matching sessions permanently,
// everything else is a plain per-board tag (independent per board — see boardTagFor).
function cardsForColumn(c, ctx, filtered) {
  if (c.cwd) return filtered.filter((s) => s.cwd === c.cwd);
  return filtered.filter((s) => boardTagFor(ctx, s) === c.id);
}

/**
 * Whether a column belongs on this board at all, independent of hidden state — shared by
 * columnWouldShow, the Manage Columns row list (orderFor), and the hidden-count chip, so a column
 * excluded here never has a dangling row or gets miscounted as "reopenable."
 */
function isInScope(c, ctx, filtered) {
  // The group lens auto-generates one column per project with sessions — once its last session is
  // gone (deleted, or filtered as unresumable), the leftover column has nothing to manage either,
  // unlike a custom column a user deliberately keeps around empty, so it's out of scope entirely.
  if (ctx.kind === "group" && cardsForColumn(c, ctx, filtered).length === 0) return false;
  return true;
}

/**
 * Single source of truth for whether a column would actually render on the board right now — the
 * Manage Columns panel's toggle state is driven by this same function, so it never disagrees with
 * what's really on screen.
 */
function columnWouldShow(c, ctx, filtered, menuOpen) {
  if (!isInScope(c, ctx, filtered)) return false;
  // Hidden is a preference you're actively managing, so Manage Columns reveals it while open.
  if (menuOpen) return true;
  return !c.hidden;
}

// A project column's slot comes from the exact same ranking projectColorClass uses for card chips
// (see ui/projectColors.js), so a project's column header and its own cards always match. A plain
// custom column has no chip to match, so it keeps the old order-independent id-sort rank instead.
const PILL_PALETTE_SIZE = 9;
function pillColorClass(ctx, c) {
  if (c.cwd) {
    const rank = projectColorRank(c.cwd);
    return rank == null ? "col-pill-1" : `col-pill-${rank}`;
  }
  const rank = [...ctx.cols]
    .filter((x) => !x.cwd)
    .map((x) => x.id)
    .sort()
    .indexOf(c.id);
  return `col-pill-${(rank % PILL_PALETTE_SIZE) + 1}`;
}

// clicking a project name's swatch/checkbox in the Filter projects dropdown adds or removes that
// project's column — same shape addColBtn below already uses (push + fresh flag + save), so a
// filter-toggled column pops in with the exact same animation as a manually-added one.
function toggleProjectColumn(ctx, cwd) {
  pushHistory(ctx);
  const existing = ctx.cols.find((c) => c.cwd === cwd);
  if (existing) {
    ctx.cols = ctx.cols.filter((c) => c.id !== existing.id);
  } else {
    ctx.cols.push({ id: projectColumnId(cwd), title: projectName(cwd), cwd, fresh: true });
  }
  ctx.save();
}

// The board's own page title — read-only for the group lens, inline-editable for a saved view
// (a second entry point into the exact same rename the sidebar's ⋮ menu already calls).
function viewTitleHtml(ctx) {
  if (ctx.kind === "group") {
    return `<h2 class="view-title">All Projects <span class="read-only-badge">— read-only overview</span></h2>`;
  }
  const view = savedViews.find((v) => v.id === ctx.viewId);
  return `
    <div class="view-title-row">
      <h2 class="view-title" spellcheck="false" data-view-title>${escapeHtml(view?.title || "")}</h2>
      <span class="rename-pencil view-title-pencil" data-view-title-rename title="Rename view">✎</span>
    </div>
  `;
}

// Empty-view illustration — a checkbox drawing its own checkmark, with a pulsing glow behind it;
// points straight at Filter projects/+ Add column above it instead of an abstract board glyph.
function emptyIlloSvg() {
  return `
    <svg class="empty-illo" width="96" height="92" viewBox="0 0 96 92" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <defs>
        <marker id="illoArrowHead" markerWidth="7" markerHeight="7" refX="2" refY="3.5" orient="auto">
          <path d="M0 0 L5 3.5 L0 7 Z" fill="var(--dim)" opacity="0.7"/>
        </marker>
      </defs>
      <path class="arrow" d="M48 4 C 20 4, 6 18, 8 34" marker-end="url(#illoArrowHead)"/>
      <circle class="glow" cx="48" cy="60" r="30"/>
      <rect class="box" x="24" y="36" width="48" height="48" rx="12"/>
      <path class="check" d="M35 61 L45 71 L64 49"/>
    </svg>
  `;
}

let filterMenuOpen = false;

// Registered once at module load, not per-render — the board re-renders wholesale on every
// change, so a per-render listener would stack a fresh one each time.
document.addEventListener("click", (e) => {
  if (!filterMenuOpen) return;
  if (e.target.closest(".project-filter-wrap")) return;
  filterMenuOpen = false;
  import("../../pages/sessionsPage.js").then((m) => m.render());
});

export function renderBoardView(filtered, ctx, breadcrumbHtml = "") {
  const app = document.getElementById("app");
  const menuOpen = isManageColumnsMenuOpen();
  const visibleCols = ctx.cols.filter((c) => columnWouldShow(c, ctx, filtered, menuOpen));
  const inScopeCount = ctx.cols.filter((c) => isInScope(c, ctx, filtered)).length;
  const hiddenCount = inScopeCount - visibleCols.length;
  const anyExpanded = visibleCols.some((c) => !c.collapsed);

  // Every render replaces .board's innerHTML, which resets scrollLeft to 0 — save/restore it (and
  // each column's scrollTop) so the board doesn't jerk back mid-scroll.
  const prevScrollLeft = app.querySelector(".board")?.scrollLeft || 0;
  const prevColScrollTops = new Map();
  app.querySelectorAll(".board-col-body[data-col-drop]").forEach((el) => {
    prevColScrollTops.set(el.dataset.colDrop, el.scrollTop);
  });

  // Every known project, most-recently-active first (same ordering "Regroup by project" uses).
  const projectCwds = [...new Set(sessions.filter((s) => s.cwd).map((s) => s.cwd))]
    .sort((a, b) => projectRecency(b, sessions) - projectRecency(a, sessions));
  const checkedCount = ctx.cols.filter((c) => c.cwd).length;

  app.innerHTML = `
    ${breadcrumbHtml}
    <div class="board-sticky-toolbar">
    ${viewTitleHtml(ctx)}
    ${agentsDockHtml()}
    <div class="board-actions">
      ${ctx.kind === "group" ? "" : `
        <div class="project-filter-wrap">
          <button class="btn filter-projects-btn" id="filterProjectsBtn">☰ Filter projects <span class="pf-count">${checkedCount}</span></button>
          <div class="bc-dropdown project-filter-dropdown ${filterMenuOpen ? "open" : ""}" id="filterProjectsDropdown">
            <div class="pf-label">Show projects as columns</div>
            ${projectCwds.map((cwd) => `
              <label class="pf-row">
                <input type="checkbox" data-toggle-project-col="${escapeHtml(cwd)}" ${ctx.cols.some((c) => c.cwd === cwd) ? "checked" : ""} />
                <span class="pf-swatch ${pillColorClass(ctx, { cwd })}"></span>
                <span class="pf-name">${escapeHtml(projectName(cwd))}</span>
                <span class="pf-count">${sessions.filter((s) => s.cwd === cwd && !s.isTicket).length}</span>
              </label>
            `).join("")}
          </div>
        </div>
        <button class="btn ghost" id="addColBtn">+ Add column</button>
      `}
      <span style="flex:1"></span>
      ${ctx.kind === "group" ? "" : `
        <button class="btn ghost" id="boardUndoBtn" ${hasHistoryFor(ctx) ? "" : "disabled"} title="Undo the last change to this board">↩ Undo</button>`}
      <button class="btn ghost" id="collapseAllBtn" title="${anyExpanded ? "Collapse every column" : "Expand every column"}">${anyExpanded ? "« Collapse all" : "» Expand all"}</button>
      ${manageColumnsButtonHtml()}
    </div>
    </div>
    ${ctx.kind !== "group" && ctx.cols.length === 0 ? `
      <div class="empty-board">
        ${emptyIlloSvg()}
        <h3>This view is empty</h3>
        <p>Use <b>Filter projects</b> above to add a project's column, or <b>+ Add column</b> for a custom one — nothing renders until you add at least one.</p>
      </div>
    ` : `
    <div class="board">
      ${visibleCols.map((c) => {
        const items = cardsForColumn(c, ctx, filtered).sort(
          (a, b) => (b.running ? 1 : 0) - (a.running ? 1 : 0) || b.lastActive - a.lastActive
        );
        const titleHtml = c.renaming
          ? `<input class="col-title-input" data-rename-col-input="${c.id}" value="${escapeHtml(c.title)}" />`
          : `<span>${escapeHtml(c.title)}</span>`;

        // Header/body and collapsed pill both stay in the DOM; only a .collapsed class (toggled
        // directly, not via rerender) switches them, so the CSS transition has something to animate.
        return `
        <div class="board-col${c.hidden ? " board-col-hidden" : ""}${c.fresh ? " new-col" : ""}${c.collapsed ? " collapsed" : ""} ${pillColorClass(ctx, c)}" data-col-id="${c.id}">
          <div class="board-col-header" draggable="${!c.renaming}" data-col-drag="${c.id}" title="Drag to reorder columns">
            <span class="drag-handle">⠿</span>
            ${titleHtml}
            <span class="board-count">${items.length}</span>
            ${ctx.kind === "group" ? "" : `<button class="col-add-btn" data-add-col-task="${c.id}" title="New task">${PLUS_ICON}<span>New</span></button>`}
            <div class="col-header-actions">
              <button class="collapse-toggle" data-collapse-col="${c.id}" title="Collapse group">◀</button>
              <div class="bc-menu-wrap">
                <button class="bc-menu-btn" data-menu-toggle="col-${c.id}" title="Options">⋯</button>
                <div class="bc-dropdown" id="menu-col-${c.id}">
                  ${c.cwd ? "" : `<button data-rename-col-menu="${c.id}">✎ Rename</button>`}
                  <button data-collapse-col="${c.id}">◀ Collapse group</button>
                  <button data-hide-col-menu="${c.id}">🙈 Hide column</button>
                  ${ctx.kind === "group" ? "" : `<button data-delete-col-menu="${c.id}" class="danger">✕ Delete column</button>`}
                </div>
              </div>
              ${ctx.kind === "group" ? "" : `<span class="col-close" data-remove-col="${c.id}" title="Remove column">✕</span>`}
            </div>
          </div>
          <div class="collapsed-pill" draggable="true" data-col-drag="${c.id}" data-expand-col="${c.id}" title="Expand &quot;${escapeHtml(c.title)}&quot;">
            <div class="pill-badge">${escapeHtml(c.title)}</div>
            <div class="pill-count">${items.length}</div>
          </div>
          <div class="board-col-body" data-col-drop="${c.id}">
            ${items.map((s) => boardCardHtml(s, ctx)).join("") || '<div class="empty" style="padding:16px 0;">Drop here</div>'}
          </div>
        </div>
      `;
      }).join("")}
      ${ctx.kind === "group" ? "" : `<div class="add-col-inline" id="addColInlineBtn">+ Add column</div>`}
      ${hiddenCount ? `<div class="board-col hidden-chip">${hiddenCount} hidden column${hiddenCount === 1 ? "" : "s"} — ⋮ Manage columns to reopen</div>` : ""}
    </div>
    `}
  `;

  const boardEl = app.querySelector(".board");
  if (boardEl) boardEl.scrollLeft = prevScrollLeft;
  // .board's sticky offset (styles.css) reads this — the toolbar's height varies with content
  // (agents dock, project-filter row) and is rebuilt on every render, so it's measured live rather
  // than hardcoded, same idea as --header-h in main.js.
  const toolbarH = app.querySelector(".board-sticky-toolbar")?.offsetHeight;
  if (toolbarH) document.documentElement.style.setProperty("--toolbar-h", toolbarH + "px");
  app.querySelectorAll(".board-col-body[data-col-drop]").forEach((el) => {
    const prev = prevColScrollTops.get(el.dataset.colDrop);
    if (prev) el.scrollTop = prev;
  });

  wireBoardCards(app);

  const rerender = () => import("../../pages/sessionsPage.js").then((m) => m.render());

  document.getElementById("filterProjectsBtn")?.addEventListener("click", (e) => {
    e.stopPropagation();
    filterMenuOpen = !filterMenuOpen;
    rerender();
  });
  document.querySelectorAll("[data-toggle-project-col]").forEach((el) => {
    el.addEventListener("click", (e) => {
      e.stopPropagation();
      toggleProjectColumn(ctx, el.dataset.toggleProjectCol);
      filterMenuOpen = true;
      rerender().then(() => {
        setTimeout(() => { for (const c of ctx.cols) delete c.fresh; }, 500);
      });
    });
  });

  const titleEl = app.querySelector("[data-view-title]");
  if (titleEl) {
    const commitTitle = async () => {
      titleEl.contentEditable = "false";
      const next = titleEl.textContent.trim();
      if (next && next !== savedViews.find((v) => v.id === ctx.viewId)?.title) {
        await renameSavedView(ctx.viewId, next);
        await import("../sidebar/renderSidebar.js").then((m) => m.renderSidebar());
      }
    };
    titleEl.addEventListener("blur", commitTitle);
    titleEl.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); titleEl.blur(); } });
    // Not contenteditable until the pencil is clicked — otherwise any stray click on the title
    // itself would drop straight into edit mode.
    app.querySelector("[data-view-title-rename]")?.addEventListener("click", () => {
      titleEl.contentEditable = "true";
      titleEl.focus();
      document.getSelection()?.selectAllChildren(titleEl);
    });
  }

  document.getElementById("boardUndoBtn")?.addEventListener("click", () => undoLast(ctx));

  wireManageColumnsPanel(app, ctx, {
    countFor: (c) => cardsForColumn(c, ctx, filtered).length,
    displayTitleFor: (c) => c.title,
    shownFor: (c) => columnWouldShow(c, ctx, filtered, false),
    orderFor: (cols) => cols.filter((c) => isInScope(c, ctx, filtered)),
    onRename: (id) => startColumnRename(ctx, id, rerender),
    onDeleteColumn: (id) => removeColumn(ctx, id, rerender),
    onReorder: (fromId, toId) => reorderColumns(ctx, fromId, toId, rerender),
    rerender,
  });

  app.querySelectorAll("[data-add-col-task]").forEach((el) => {
    el.addEventListener("click", (e) => {
      e.stopPropagation();
      openColumnTaskModal(el.dataset.addColTask, ctx);
    });
  });

  wireInlineRename(app, ctx, rerender);

  /** Re-resolves visibleCols by id against ctx.cols — a poll can swap it for fresh objects mid-render. */
  const visibleColIds = visibleCols.map((c) => c.id);
  function liveVisibleCols() {
    return ctx.cols.filter((c) => visibleColIds.includes(c.id));
  }

  // "Collapse/Expand all" label mirrors the live collapsed state, not just the render-time snapshot
  function refreshCollapseAllBtn() {
    const btn = document.getElementById("collapseAllBtn");
    if (!btn) return;
    const expanded = liveVisibleCols().some((c) => !c.collapsed);
    btn.textContent = expanded ? "« Collapse all" : "» Expand all";
    btn.title = expanded ? "Collapse every column" : "Expand every column";
  }

  // Toggles .collapsed directly on the existing element (not via rerender, which would cut the CSS
  // transition short); the next natural render picks up the persisted state.
  function setColumnCollapsed(id, collapsed) {
    const c = ctx.cols.find((x) => x.id === id);
    if (!c) return;
    pushHistory(ctx);
    if (collapsed) c.collapsed = true;
    else delete c.collapsed;
    ctx.save();
    app.querySelector(`.board-col[data-col-id="${id}"]`)?.classList.toggle("collapsed", collapsed);
    refreshCollapseAllBtn();
  }
  app.querySelectorAll("[data-collapse-col]").forEach((el) => {
    el.addEventListener("click", (e) => {
      e.stopPropagation();
      document.querySelectorAll(".bc-dropdown.open").forEach((d) => d.classList.remove("open"));
      setColumnCollapsed(el.dataset.collapseCol, true);
    });
  });
  app.querySelectorAll("[data-expand-col]").forEach((el) => {
    el.addEventListener("click", (e) => {
      e.stopPropagation();
      setColumnCollapsed(el.dataset.expandCol, false);
    });
  });
  app.querySelectorAll("[data-rename-col-menu]").forEach((el) => {
    el.addEventListener("click", (e) => {
      e.stopPropagation();
      document.querySelectorAll(".bc-dropdown.open").forEach((d) => d.classList.remove("open"));
      startColumnRename(ctx, el.dataset.renameColMenu, rerender);
    });
  });
  app.querySelectorAll("[data-hide-col-menu]").forEach((el) => {
    el.addEventListener("click", (e) => {
      e.stopPropagation();
      document.querySelectorAll(".bc-dropdown.open").forEach((d) => d.classList.remove("open"));
      const c = ctx.cols.find((x) => x.id === el.dataset.hideColMenu);
      if (!c) return;
      pushHistory(ctx);
      c.hidden = true;
      ctx.save();
      rerender();
    });
  });
  app.querySelectorAll("[data-delete-col-menu], [data-remove-col]").forEach((el) => {
    el.addEventListener("click", (e) => {
      e.stopPropagation();
      document.querySelectorAll(".bc-dropdown.open").forEach((d) => d.classList.remove("open"));
      removeColumn(ctx, el.dataset.deleteColMenu || el.dataset.removeCol, rerender);
    });
  });
  document.getElementById("collapseAllBtn")?.addEventListener("click", () => {
    // re-read collapsed state at click time, not the render-time snapshot — otherwise a second
    // click re-applies the same direction instead of toggling back
    const expandedNow = liveVisibleCols().some((c) => !c.collapsed);
    visibleColIds.forEach((id) => setColumnCollapsed(id, expandedNow));
  });

  // Same "+ Add column" action, reachable from the toolbar button and from the dashed inline
  // placeholder at the end of the column row — both call this one handler. No dialog of any
  // kind: the column is created immediately and lands straight in its own inline rename input
  // (the same one the ✎ pencil opens), so typing a name is the only step left.
  document.querySelectorAll("#addColBtn, #addColInlineBtn").forEach((el) => el.addEventListener("click", () => {
    pushHistory(ctx);
    const created = { id: "custom-" + Date.now(), title: "New column", fresh: true, renaming: true };
    ctx.cols.push(created);
    ctx.save();
    rerender().then(() => {
      document.querySelector(".board")?.scrollTo({ left: document.querySelector(".board")?.scrollWidth || 0, behavior: "smooth" });
    });
    setTimeout(() => { delete created.fresh; }, 500);
  }));

  wireBoardDragDrop(app, ctx, rerender);
  wireAgentsDock(app);
}

function startColumnRename(ctx, id, rerender) {
  const c = ctx.cols.find((x) => x.id === id);
  if (!c) return;
  c.renaming = true;
  rerender();
}

function commitColumnRename(ctx, id, nextTitle, rerender) {
  const c = ctx.cols.find((x) => x.id === id);
  if (!c) return;
  delete c.renaming;
  const trimmed = nextTitle.trim();
  if (trimmed && trimmed !== c.title) {
    pushHistory(ctx);
    c.title = trimmed;
    ctx.save();
  }
  rerender();
}

function wireInlineRename(app, ctx, rerender) {
  app.querySelectorAll("[data-rename-col-input]").forEach((input) => {
    const id = input.dataset.renameColInput;
    input.addEventListener("click", (e) => e.stopPropagation());
    input.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Enter") { e.preventDefault(); commitColumnRename(ctx, id, input.value, rerender); }
      if (e.key === "Escape") { e.preventDefault(); commitColumnRename(ctx, id, ctx.cols.find((c) => c.id === id)?.title || "", rerender); }
    });
    input.addEventListener("blur", () => commitColumnRename(ctx, id, input.value, rerender));
    setTimeout(() => { input.focus(); input.select(); }, 0);
  });
}

function removeColumn(ctx, id, rerender) {
  const col = ctx.cols.find((c) => c.id === id);
  pushHistory(ctx);
  // deliberately NOT clearing meta.board on tagged sessions — that tag is what lets a saved view
  // that still has this column keep showing them, even after it's gone from the live board
  ctx.cols = ctx.cols.filter((c) => c.id !== id);
  ctx.save();
  toast(`Removed "${col?.title}" — ↩ Undo to bring it back`);
  rerender();
}
