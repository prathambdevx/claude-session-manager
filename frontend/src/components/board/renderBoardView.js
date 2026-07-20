import { sessions, autoHideEmpty, setProjectFilter } from "../../state.js";
import { escapeHtml, escapeAttr, projectName } from "../../ui/format.js";
import { enterProjectBoard, boardTagFor, projectRecency } from "../../routing/boardRouting.js";
import { projectColorRank } from "../../ui/projectColors.js";
import { boardCardHtml } from "../../subcomponents/boardCard.js";
import { wireBoardCards } from "./wireBoardCards.js";
import { agentsDockHtml, wireAgentsDock } from "../agentsDock/agentsDock.js";
import { openColumnTaskModal } from "../modals/columnTaskModal.js";
import { toast } from "../../ui/toast.js";
import { pushHistory, hasHistoryFor, undoLast } from "./boardUndo.js";
import { manageColumnsButtonHtml, wireManageColumnsPanel, isManageColumnsMenuOpen, closeManageColumnsMenu } from "./manageColumnsPanel.js";
import { openSaveViewModal } from "./saveAsView.js";
import { openPromptModal } from "../../ui/promptModal.js";
import { openConfirmModal } from "../../ui/confirmModal.js";
import { wireBoardDragDrop, reorderColumns } from "./wireBoardDragDrop.js";

// Membership is computed, not bucketed: home column shows everyone, a .cwd column shows matching
// sessions permanently, everything else is a plain per-board tag (independent per board — see
// boardTagFor in boardRouting.js).
function cardsForColumn(c, ctx, filtered, homeId, projectFilter) {
  // The project filter only narrows the home column — every other column (project-cwd or
  // tag-based) keeps showing its own real membership regardless, so organizing work you've
  // already done never disappears just because you're filtering to find something else.
  if (c.id === homeId) return projectFilter ? filtered.filter((s) => s.cwd === projectFilter) : filtered;
  if ((ctx.kind === "main" || ctx.kind === "group") && c.cwd) return filtered.filter((s) => s.cwd === c.cwd);
  return filtered.filter((s) => boardTagFor(ctx, s) === c.id);
}

/**
 * Whether a column belongs on this board at all, independent of hidden/auto-hidden-empty state —
 * shared by columnWouldShow, the Manage Columns row list (orderFor), and the hidden-count chip, so
 * a column excluded here never has a dangling row or gets miscounted as "reopenable."
 */
function isInScope(c, ctx, homeId, projectFilter, homeBorrowsProjectName) {
  // Home never shows alongside its own stand-in/dedicated column while filtered (it would otherwise
  // duplicate the same sessions under a second column).
  if (projectFilter && c.id === homeId && !homeBorrowsProjectName) return false;
  // Filtering only ever changes what the first column shows, and only on the live Main board — a
  // project-dedicated column there earns a spot solely while its own project is the active filter.
  // A saved view is a frozen snapshot: it has no filter, so this never touches one (ctx.viewId
  // marks a saved view despite sharing kind "main").
  if (ctx.kind === "main" && !ctx.viewId && c.cwd && c.cwd !== projectFilter) return false;
  return true;
}

/**
 * Single source of truth for whether a column would actually render on the board right now — the
 * Manage Columns panel's toggle state is driven by this same function, so it never disagrees with
 * what's really on screen.
 */
function columnWouldShow(c, ctx, filtered, homeId, projectFilter, homeBorrowsProjectName, menuOpen) {
  // Scoping is absolute — never bypassed by Manage Columns being open (a column excluded by
  // isInScope has no row there to manage anyway, so revealing it on the board would be a dead end).
  if (!isInScope(c, ctx, homeId, projectFilter, homeBorrowsProjectName)) return false;
  // Manual hidden / auto-hidden-empty are preferences you're actively managing, so Manage Columns
  // reveals them while open. The board's order still stays pinned to the filter (see
  // reorderForFilter, applied unconditionally below), so opening the menu never reshuffles the
  // visible layout, only reveals what else exists within the scope already fixed above.
  if (menuOpen) return true;
  // If no project column exists for the filtered project yet, home IS that project's only
  // representation on the board — it needs the same "unhide me, I'm the match" exemption a real
  // project column gets, or filtering to that project would show nothing at all.
  const isFilterMatch = projectFilter && (c.cwd === projectFilter || (c.id === homeId && homeBorrowsProjectName));
  if (c.hidden && !isFilterMatch) return false;
  if (autoHideEmpty && c.id !== homeId) {
    const count = cardsForColumn(c, ctx, filtered, homeId, projectFilter).length;
    if (count === 0 && !c.neverPopulated) return false;
  }
  return true;
}

/**
 * While filtered to one project, whatever represents it on the board — its own dedicated column,
 * or home when no dedicated column exists yet — jumps to the very front of the list. Used for both
 * the board's own column order and the Manage Columns panel's row order, so the two never disagree.
 */
function reorderForFilter(cols, homeId, projectFilter, homeBorrowsProjectName) {
  if (!projectFilter || homeBorrowsProjectName) return cols;
  const matchIdx = cols.findIndex((c) => c.cwd === projectFilter);
  if (matchIdx === -1) return cols;
  const result = [...cols];
  const [match] = result.splice(matchIdx, 1);
  const homeIdx = result.findIndex((c) => c.id === homeId);
  result.splice(homeIdx > -1 ? homeIdx + 1 : 0, 0, match);
  return result;
}

// A project column's slot comes from the exact same ranking projectColorClass uses for card chips
// (see ui/projectColors.js), so a project's column header and its own cards always match. A plain
// custom column has no chip to match, so it keeps the old order-independent id-sort rank instead.
const PILL_PALETTE_SIZE = 9;
function pillColorClass(ctx, c, homeId) {
  if (c.id === homeId) return "col-pill-neutral";
  if (c.cwd) {
    const rank = projectColorRank(c.cwd);
    return rank == null ? "col-pill-1" : `col-pill-${rank}`;
  }
  const rank = [...ctx.cols]
    .filter((x) => x.id !== homeId && !x.cwd)
    .map((x) => x.id)
    .sort()
    .indexOf(c.id);
  return `col-pill-${(rank % PILL_PALETTE_SIZE) + 1}`;
}

export function renderBoardView(filtered, ctx, breadcrumbHtml = "", projectFilter = "") {
  const app = document.getElementById("app");
  // projectFilter is shared global state — a stale value from Main board must not silently carry
  // its lock/pin behavior into a saved view, which has no filter concept of its own.
  if (ctx.viewId) projectFilter = "";
  // Home is identified by its isAll flag, not position — a saved view can freely reorder or even
  // delete it, and the "Projects" group lens never has one at all (every column there is a real
  // project), so ctx.cols.find just comes back empty in both of those cases.
  const homeId = ctx.cols.find((c) => c.isAll)?.id ?? null;
  // A dedicated project column already carries the filtered project's identity once Regroup has
  // run (and it's the one that moves to the front — see reorderForFilter) — home only borrows the
  // name when no such column exists yet, so the two never show the same label at once.
  const homeBorrowsProjectName = projectFilter && !ctx.cols.some((c) => c.cwd === projectFilter);
  const menuOpen = isManageColumnsMenuOpen();
  let populatedSinceLastSave = false;
  const rawVisibleCols = ctx.cols.filter((c) => {
    // auto-hide-empty only ever applies to a column that WAS populated and later emptied out —
    // never to one that's simply new and hasn't had a chance to receive a card yet
    if (autoHideEmpty && c.id !== homeId) {
      const count = cardsForColumn(c, ctx, filtered, homeId, projectFilter).length;
      if (count > 0 && c.neverPopulated) {
        delete c.neverPopulated;
        populatedSinceLastSave = true;
      }
    }
    return columnWouldShow(c, ctx, filtered, homeId, projectFilter, homeBorrowsProjectName, menuOpen);
  });
  // neverPopulated is persisted (survives reload/other browsers/the group lens and saved views
  // alike) — once a column's had its first card, drop the exemption for good, not just in memory.
  if (populatedSinceLastSave) ctx.save();
  // Reorder the filtered project to the front even with the menu open, so the board's order matches
  // the Manage Columns panel's order (which reorders the same way) instead of jumping around.
  const visibleCols = reorderForFilter(rawVisibleCols, homeId, projectFilter, homeBorrowsProjectName);
  // Out-of-scope columns (e.g. every other project while filtered) aren't "hidden" — they simply
  // don't belong here and have no row in Manage Columns to reopen from. Only count what's actually
  // reopenable: an in-scope column that's manually hidden or swept by auto-hide-empty.
  const inScopeCount = ctx.cols.filter((c) => isInScope(c, ctx, homeId, projectFilter, homeBorrowsProjectName)).length;
  const hiddenCount = inScopeCount - visibleCols.length;
  const anyExpanded = visibleCols.some((c) => !c.collapsed);

  // Every render replaces .board's innerHTML, which resets scrollLeft to 0 — save/restore it (and
  // each column's scrollTop) so the board doesn't jerk back mid-scroll.
  const prevScrollLeft = app.querySelector(".board")?.scrollLeft || 0;
  const prevColScrollTops = new Map();
  app.querySelectorAll(".board-col-body[data-col-drop]").forEach((el) => {
    prevColScrollTops.set(el.dataset.colDrop, el.scrollTop);
  });

  // Narrows the home column only — not shown for the group lens (no home column), a per-project
  // board (already one project), or a saved view (a frozen snapshot with no live filtering, though
  // its columns are still hand-editable via Manage Columns).
  const showProjectFilter = homeId != null && ctx.kind === "main" && !ctx.viewId;
  // Same most-recently-active-first ordering "Regroup by project" uses — whichever project you
  // actually touched last is the one you're most likely filtering to.
  const projectCwds = [...new Set(sessions.filter((s) => s.cwd).map((s) => s.cwd))]
    .sort((a, b) => projectRecency(b, sessions) - projectRecency(a, sessions));

  app.innerHTML = `
    ${breadcrumbHtml}
    ${agentsDockHtml()}
    <div class="board-actions">
      ${ctx.kind === "group" ? "" : `
        ${showProjectFilter ? `
          <div class="project-filter-wrap">
            <button class="btn ghost" id="projectFilterToggle" title="Narrow the home column down to one project">
              ${escapeHtml(projectFilter ? projectName(projectFilter) : "All sessions")} <span class="pf-caret">▾</span>
            </button>
            <div class="bc-dropdown project-filter-dropdown" id="projectFilterDropdown">
              <button data-project-filter-option="" class="${!projectFilter ? "active" : ""}">All sessions</button>
              ${projectCwds.map((cwd) => `<button data-project-filter-option="${escapeAttr(cwd)}" class="${cwd === projectFilter ? "active" : ""}">${escapeHtml(projectName(cwd))}</button>`).join("")}
            </div>
          </div>` : ""}
        <button class="btn ghost" id="addColBtn">+ Add column</button>
      `}
      <span style="flex:1"></span>
      <button class="btn ghost" id="saveViewBtn" title="Save this column layout as a reusable view">＋ Save as view</button>
      ${ctx.kind === "group" ? "" : `
        <button class="btn ghost" id="boardUndoBtn" ${hasHistoryFor(ctx) ? "" : "disabled"} title="Undo the last change to this board">↩ Undo</button>`}
      <button class="btn ghost" id="collapseAllBtn" title="${anyExpanded ? "Collapse every column" : "Expand every column"}">${anyExpanded ? "« Collapse all" : "» Expand all"}</button>
      ${manageColumnsButtonHtml()}
    </div>
    <div class="board">
      ${visibleCols.map((c) => {
        const items = cardsForColumn(c, ctx, filtered, homeId, projectFilter).sort(
          (a, b) => (b.running ? 1 : 0) - (a.running ? 1 : 0) || b.lastActive - a.lastActive
        );
        // The home column names itself after whatever it's actually showing — a per-project board
        // is always exactly one project already, and the shared home column on Main/a saved view
        // narrows to one project the moment you filter, so calling either "All sessions" would
        // overstate what's on screen.
        const displayTitle = c.id === homeId && ctx.kind === "project" ? projectName(ctx.cwd)
          : c.id === homeId && homeBorrowsProjectName ? projectName(projectFilter)
          : c.title;
        const titleHtml = c.renaming
          ? `<input class="col-title-input" data-rename-col-input="${c.id}" value="${escapeAttr(c.title)}" />`
          : c.cwd
            ? `<span class="col-title-link" data-col-title="${c.id}" title="Open ${escapeAttr(projectName(c.cwd))}'s own board">${escapeHtml(c.title)}</span>`
            : `<span>${escapeHtml(displayTitle)}</span>`;

        // Header/body and collapsed pill both stay in the DOM; only a .collapsed class (toggled
        // directly, not via rerender) switches them, so the CSS transition has something to animate.
        // Home column stays pinned first while visible — see reorderColumns; undraggable here too
        // so it doesn't snap back after a confusing drag. The filtered project's column is pinned
        // first the same way (reorderForFilter re-front-loads it every render), so lock its drag too.
        const dragLocked = (c.id === homeId && !c.hidden && !ctx.viewId) || (projectFilter && c.cwd === projectFilter);
        // A column only forced into view by the active filter (still c.hidden underneath) reads as
        // a normal, fully-visible column — the dashed/dimmed treatment is reserved for the
        // "N hidden columns" chip's own members, which this one currently isn't. Auto-hidden-empty
        // columns get the same dimmed treatment as manually-hidden ones while the menu holds them
        // visible — otherwise they looked identical to a normal column despite being "hidden".
        const isAutoHiddenNow = autoHideEmpty && c.id !== homeId && !c.neverPopulated && items.length === 0;
        const stillHidden = (c.hidden || isAutoHiddenNow) && !(projectFilter && (c.cwd === projectFilter || (c.id === homeId && homeBorrowsProjectName)));
        return `
        <div class="board-col${dragLocked ? " board-col-sticky" : ""}${stillHidden ? " board-col-hidden" : ""}${c.fresh ? " new-col" : ""}${c.collapsed ? " collapsed" : ""} ${pillColorClass(ctx, c, homeId)}" data-col-id="${c.id}">
          <div class="board-col-header" draggable="${!c.renaming && !dragLocked}" data-col-drag="${c.id}" title="${dragLocked ? "Always stays first" : c.cwd ? "Drag to reorder" : "Drag to reorder columns"}">
            <span class="drag-handle">⠿</span>
            ${titleHtml}
            <span class="board-count">${items.length}</span>
            <div class="col-header-actions">
              <button class="collapse-toggle" data-collapse-col="${c.id}" title="Collapse group">◀</button>
              <div class="bc-menu-wrap">
                <button class="bc-menu-btn" data-menu-toggle="col-${c.id}" title="Options">⋯</button>
                <div class="bc-dropdown" id="menu-col-${c.id}">
                  <button data-rename-col-menu="${c.id}">✎ Rename</button>
                  <button data-collapse-col="${c.id}">◀ Collapse group</button>
                  <button data-hide-col-menu="${c.id}">🙈 Hide column</button>
                  ${(c.id === homeId && !ctx.viewId) || ctx.kind === "group" ? "" : `<button data-delete-col-menu="${c.id}" class="danger">✕ Delete column</button>`}
                </div>
              </div>
              <span class="col-add-btn" data-add-col-task="${c.id}" title="New task">+</span>
            </div>
          </div>
          <div class="collapsed-pill" draggable="true" data-col-drag="${c.id}" data-expand-col="${c.id}" title="Expand &quot;${escapeAttr(c.title)}&quot;">
            <div class="pill-badge">${escapeHtml(c.title)}</div>
            <div class="pill-count">${items.length}</div>
          </div>
          <div class="board-col-body" data-col-drop="${c.id}">
            ${items.map((s) => boardCardHtml(s, ctx)).join("") || '<div class="empty" style="padding:16px 0;">Drop here</div>'}
          </div>
        </div>
      `;
      }).join("")}
      ${hiddenCount && !isManageColumnsMenuOpen() ? `<div class="board-col hidden-chip">${hiddenCount} hidden column${hiddenCount === 1 ? "" : "s"} — ⋮ Manage columns to reopen</div>` : ""}
    </div>
  `;

  const boardEl = app.querySelector(".board");
  if (boardEl) boardEl.scrollLeft = prevScrollLeft;
  app.querySelectorAll(".board-col-body[data-col-drop]").forEach((el) => {
    const prev = prevColScrollTops.get(el.dataset.colDrop);
    if (prev) el.scrollTop = prev;
  });

  wireBoardCards(app);

  const rerender = () => import("../../pages/sessionsPage.js").then((m) => m.render());

  document.getElementById("projectFilterToggle")?.addEventListener("click", (e) => {
    e.stopPropagation();
    const dropdown = document.getElementById("projectFilterDropdown");
    const wasOpen = dropdown.classList.contains("open");
    document.querySelectorAll(".bc-dropdown.open").forEach((d) => d.classList.remove("open"));
    if (!wasOpen) dropdown.classList.add("open");
  });
  document.querySelectorAll("[data-project-filter-option]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const value = btn.dataset.projectFilterOption;
      setProjectFilter(value);
      // Selecting "All sessions" is the one point where you're explicitly asking to see everything
      // again — un-hide home for good if it had been hidden, rather than leaving it invisible with
      // no obvious way back short of a trip to Manage Columns.
      if (!value) {
        const home = ctx.cols.find((c) => c.id === homeId);
        if (home?.hidden) {
          pushHistory(ctx);
          home.hidden = false;
          ctx.save();
        }
      }
      rerender();
    });
  });
  document.getElementById("boardUndoBtn")?.addEventListener("click", () => undoLast(ctx));
  document.getElementById("saveViewBtn")?.addEventListener("click", () => {
    // The on-screen columns, in on-screen order, are the snapshot: columnWouldShow (menu forced
    // closed) drops hidden, auto-hidden-empty, and filtered-out columns — exactly what's not visible.
    const onScreenCols = reorderForFilter(
      ctx.cols.filter((c) => columnWouldShow(c, ctx, filtered, homeId, projectFilter, homeBorrowsProjectName, false)),
      homeId, projectFilter, homeBorrowsProjectName,
    );
    openSaveViewModal(onScreenCols, ctx, { homeId, homeBorrowsProjectName, projectFilter });
  });

  wireManageColumnsPanel(app, ctx, {
    countFor: (c) => cardsForColumn(c, ctx, filtered, homeId, projectFilter).length,
    displayTitleFor: (c) => c.id === homeId && ctx.kind === "project" ? projectName(ctx.cwd)
      : c.id === homeId && homeBorrowsProjectName ? projectName(projectFilter)
      : c.title,
    shownFor: (c) => columnWouldShow(c, ctx, filtered, homeId, projectFilter, homeBorrowsProjectName),
    isAllFor: (c) => c.id === homeId,
    // "All sessions" has nothing to add once a project with its own column is filtered — its row
    // would just sit there permanently off, so it's dropped entirely rather than shown as a dead
    // toggle. Same for every OTHER project column on Main board: it can only ever appear via the
    // filter, never via this panel, so there's nothing here for it to manage until it's the match —
    // the filter dropdown right next to this button is the actual way to bring one into view.
    orderFor: (cols) => reorderForFilter(
      cols.filter((c) => isInScope(c, ctx, homeId, projectFilter, homeBorrowsProjectName)),
      homeId, projectFilter, homeBorrowsProjectName
    ),
    // Home counts as the filter match too when it's standing in for a project with no dedicated
    // column yet (homeBorrowsProjectName) — hiding it in that case would strand you with nothing
    // representing the very project you filtered to, same as hiding a real dedicated column would.
    lockedFor: (c) => Boolean(projectFilter) && (c.cwd === projectFilter || (c.id === homeId && homeBorrowsProjectName)),
    onRename: (id) => startColumnRename(ctx, id, rerender),
    onDeleteColumn: (id) => removeColumn(ctx, id, rerender),
    onReorder: (fromId, toId) => reorderColumns(ctx, fromId, toId, rerender),
    rerender,
  });

  // clicking a project column's title drills into that project's own board (plain custom
  // columns have no cwd, so this is a no-op for them — see the empty data-col-title guard)
  app.querySelectorAll("[data-col-title]").forEach((el) => {
    el.addEventListener("click", (e) => {
      e.stopPropagation();
      const col = ctx.cols.find((c) => c.id === el.dataset.colTitle);
      if (col?.cwd) enterProjectBoard(col.cwd);
    });
  });

  app.querySelectorAll("[data-add-col-task]").forEach((el) => {
    el.addEventListener("click", (e) => {
      e.stopPropagation();
      openColumnTaskModal(el.dataset.addColTask, ctx);
    });
  });

  wireInlineRename(app, ctx, rerender);

  // "Collapse/Expand all" label mirrors visibleCols' live collapsed state, not just the render-time snapshot
  function refreshCollapseAllBtn() {
    const btn = document.getElementById("collapseAllBtn");
    if (!btn) return;
    const expanded = visibleCols.some((c) => !c.collapsed);
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
  app.querySelectorAll("[data-delete-col-menu]").forEach((el) => {
    el.addEventListener("click", (e) => {
      e.stopPropagation();
      document.querySelectorAll(".bc-dropdown.open").forEach((d) => d.classList.remove("open"));
      removeColumn(ctx, el.dataset.deleteColMenu, rerender);
    });
  });
  document.getElementById("collapseAllBtn")?.addEventListener("click", () => {
    // re-read collapsed state at click time, not the render-time snapshot — otherwise a second
    // click re-applies the same direction instead of toggling back
    const expandedNow = visibleCols.some((c) => !c.collapsed);
    visibleCols.forEach((c) => setColumnCollapsed(c.id, expandedNow));
  });

  document.getElementById("addColBtn")?.addEventListener("click", async () => {
    const title = await openPromptModal({
      title: "Add column", label: "Column name", placeholder: "e.g. Blocked",
      validate: (v) => ctx.cols.some((c) => c.title.trim().toLowerCase() === v.trim().toLowerCase())
        ? `A column named "${v.trim()}" already exists` : null,
    });
    if (!title || !title.trim()) return;
    pushHistory(ctx);
    const created = { id: "custom-" + Date.now(), title: title.trim(), fresh: true, neverPopulated: true };
    // lands right next to home ("All sessions") — or at the very front if home is hidden, missing
    // (a saved view that's deleted it), or not first to begin with
    const homeIdx = ctx.cols.findIndex((c) => c.isAll);
    const home = ctx.cols[homeIdx];
    const insertAt = home && !home.hidden ? homeIdx + 1 : 0;
    ctx.cols.splice(insertAt, 0, created);
    ctx.save();
    rerender().then(() => {
      // The new column always lands right after the sticky home column — but scrollIntoView()
      // doesn't know home is sticky, so if the board was already scrolled right, it can decide
      // the new column is "visible enough" while it's actually rendering directly underneath
      // home's pinned position. Scrolling the board fully left guarantees home and the new
      // column both sit in the clear, un-occluded part of the viewport.
      document.querySelector(".board")?.scrollTo({ left: 0, behavior: "smooth" });
    });
    setTimeout(() => { delete created.fresh; }, 500);
  });

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

async function removeColumn(ctx, id, rerender) {
  const col = ctx.cols.find((c) => c.id === id);
  // A saved view is a frozen snapshot, not a live board — "All sessions" is deletable there too.
  if (col?.isAll && !ctx.viewId) { toast(`"${col.title}" can't be deleted — hide it instead`); return; }
  if (ctx.cols.length <= 1) { toast("Need at least one column"); return; }
  const ok = await openConfirmModal({
    title: `Remove column "${col?.title}"?`,
    message: "This only removes it from this board — its sessions keep their tag, so they'll still show up here if a saved view has this same column.",
    confirmLabel: "Remove",
    danger: true,
  });
  if (!ok) return;
  pushHistory(ctx);
  // deliberately NOT clearing meta.board on tagged sessions — that tag is what lets a saved view
  // that still has this column keep showing them, even after it's gone from the live board
  ctx.cols = ctx.cols.filter((c) => c.id !== id);
  ctx.save();
  rerender();
}

