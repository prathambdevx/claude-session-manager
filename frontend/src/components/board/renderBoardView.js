import { sessions, autoHideEmpty } from "../../state.js";
import { escapeHtml, escapeAttr, projectName } from "../../ui/format.js";
import { patchMeta } from "../../api/sessionsApi.js";
import { setBoardMode, enterProjectBoard, ensureAllProjectColumns, boardTagFor, setBoardTag } from "../../routing/boardRouting.js";
import { boardCardHtml } from "../../subcomponents/boardCard.js";
import { wireBoardCards } from "./wireBoardCards.js";
import { agentsDockHtml, wireAgentsDock } from "../agentsDock/agentsDock.js";
import { openColumnTaskModal } from "../modals/columnTaskModal.js";
import { toast } from "../../ui/toast.js";
import { pushHistory, hasHistoryFor, undoLast } from "./boardUndo.js";
import { manageColumnsButtonHtml, wireManageColumnsPanel, isManageColumnsMenuOpen, closeManageColumnsMenu } from "./manageColumnsPanel.js";
import { createSavedView } from "../../api/savedViewsApi.js";
import { openPromptModal } from "../../ui/promptModal.js";
import { openConfirmModal } from "../../ui/confirmModal.js";

// Membership is computed, not bucketed: home column shows everyone, a .cwd column shows matching
// sessions permanently, everything else is a plain per-board tag (independent per board — see
// boardTagFor in boardRouting.js).
function cardsForColumn(c, ctx, filtered, homeId) {
  if (c.id === homeId) return filtered;
  if ((ctx.kind === "main" || ctx.kind === "group") && c.cwd) return filtered.filter((s) => s.cwd === c.cwd);
  return filtered.filter((s) => boardTagFor(ctx, s) === c.id);
}

function missingProjectCount(ctx) {
  if (ctx.kind !== "main") return 0;
  const existing = new Set(ctx.cols.filter((c) => c.cwd).map((c) => c.cwd));
  return new Set(sessions.filter((s) => !s.isTicket && !existing.has(s.cwd)).map((s) => s.cwd)).size;
}

// Palette slot = column's rank when ctx.cols is sorted by id (excluding home) — order-independent,
// so dragging columns never reassigns colors.
const PILL_PALETTE_SIZE = 9;
function pillColorClass(ctx, c) {
  const homeId = ctx.kind === "group" ? null : ctx.cols[0]?.id;
  if (c.id === homeId) return "col-pill-neutral";
  const rank = [...ctx.cols]
    .filter((x) => x.id !== homeId)
    .map((x) => x.id)
    .sort()
    .indexOf(c.id);
  return `col-pill-${(rank % PILL_PALETTE_SIZE) + 1}`;
}

export function renderBoardView(filtered, ctx, breadcrumbHtml = "") {
  const app = document.getElementById("app");
  // the "Projects" group lens has no home column — every one of its columns is a real project
  const homeId = ctx.kind === "group" ? null : ctx.cols[0]?.id;
  const menuOpen = isManageColumnsMenuOpen();
  const visibleCols = ctx.cols.filter((c) => {
    if (menuOpen) return true;
    if (c.hidden) return false;
    // auto-hide-empty only ever applies to a column that WAS populated and later emptied out —
    // never to one that's simply new and hasn't had a chance to receive a card yet
    if (autoHideEmpty && c.id !== homeId) {
      const count = cardsForColumn(c, ctx, filtered, homeId).length;
      if (count > 0 && c.neverPopulated) delete c.neverPopulated;
      if (count === 0 && !c.neverPopulated) return false;
    }
    return true;
  });
  // everything not on screen, whether manually hidden or swept by auto-hide-empty — both are
  // reopenable from Manage Columns, so both belong in the "N hidden columns" chip
  const hiddenCount = ctx.cols.length - visibleCols.length;
  const anyExpanded = visibleCols.some((c) => !c.collapsed);

  const drift = missingProjectCount(ctx);

  // Every render replaces .board's innerHTML, which resets scrollLeft to 0 — save/restore it (and
  // each column's scrollTop) so the board doesn't jerk back mid-scroll.
  const prevScrollLeft = app.querySelector(".board")?.scrollLeft || 0;
  const prevColScrollTops = new Map();
  app.querySelectorAll(".board-col-body[data-col-drop]").forEach((el) => {
    prevColScrollTops.set(el.dataset.colDrop, el.scrollTop);
  });

  app.innerHTML = `
    ${breadcrumbHtml}
    ${agentsDockHtml()}
    <div class="board-actions">
      ${ctx.kind === "group" ? "" : `
        <button class="btn ghost" id="addColBtn">+ Add column</button>
        ${ctx.kind === "main" ? `
          <button class="btn accent" id="regroupBtn" title="${drift ? `${drift} project${drift === 1 ? "" : "s"} would get a column` : "Every project already has a column"}">
            ↻ Regroup by project${drift ? ` <span class="badge">${drift}</span>` : ""}
          </button>` : ""}
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
        const items = cardsForColumn(c, ctx, filtered, homeId).sort(
          (a, b) => (b.running ? 1 : 0) - (a.running ? 1 : 0) || b.lastActive - a.lastActive
        );
        const titleHtml = c.renaming
          ? `<input class="col-title-input" data-rename-col-input="${c.id}" value="${escapeAttr(c.title)}" />`
          : c.cwd
            ? `<span class="col-title-link" data-col-title="${c.id}" title="Open ${escapeAttr(projectName(c.cwd))}'s own board">${escapeHtml(c.title)}</span>`
            : `<span>${escapeHtml(c.title)}</span>`;

        // Header/body and collapsed pill both stay in the DOM; only a .collapsed class (toggled
        // directly, not via rerender) switches them, so the CSS transition has something to animate.
        return `
        <div class="board-col${c.hidden ? " board-col-hidden" : ""}${c.fresh ? " new-col" : ""}${c.collapsed ? " collapsed" : ""} ${pillColorClass(ctx, c)}" data-col-id="${c.id}">
          <div class="board-col-header" draggable="${!c.renaming}" data-col-drag="${c.id}" title="${c.cwd ? "Drag to reorder" : "Drag to reorder columns"}">
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
                  ${c.id === homeId || ctx.kind === "group" ? "" : `<button data-delete-col-menu="${c.id}" class="danger">✕ Delete column</button>`}
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
            ${items.map(boardCardHtml).join("") || '<div class="empty" style="padding:16px 0;">Drop here</div>'}
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

  if (breadcrumbHtml) {
    app.querySelector("[data-back-to-main]")?.addEventListener("click", () => setBoardMode("main"));
  }

  wireBoardCards(app);

  const rerender = () => import("../../pages/sessionsPage.js").then((m) => m.render());

  document.getElementById("regroupBtn")?.addEventListener("click", () => ensureAllProjectColumns(ctx));
  document.getElementById("boardUndoBtn")?.addEventListener("click", () => undoLast(ctx));
  document.getElementById("saveViewBtn")?.addEventListener("click", async () => {
    const title = await openPromptModal({ title: "Save as view", label: "View name" });
    // snapshot only what's actually on screen — hidden columns aren't part of the saved layout
    if (title && title.trim()) createSavedView(title.trim(), ctx.cols.filter((c) => !c.hidden));
  });

  wireManageColumnsPanel(app, ctx, {
    countFor: (c) => cardsForColumn(c, ctx, filtered, homeId).length,
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
    const title = await openPromptModal({ title: "Add column", label: "Column name", placeholder: "e.g. Blocked" });
    if (!title || !title.trim()) return;
    pushHistory(ctx);
    const created = { id: "custom-" + Date.now(), title: title.trim(), fresh: true, neverPopulated: true };
    // lands right next to the home column ("All sessions") — or first, if that's currently hidden
    const home = ctx.cols[0];
    const insertAt = home && home.hidden ? 0 : 1;
    ctx.cols.splice(insertAt, 0, created);
    ctx.save();
    rerender().then(() => {
      document.querySelector(`[data-col-id="${created.id}"]`)?.scrollIntoView({ behavior: "smooth", inline: "start", block: "nearest" });
    });
    setTimeout(() => { delete created.fresh; }, 500);
  });

  // drag & drop — cards move between columns, column headers reorder columns
  app.querySelectorAll(".board-card").forEach((card) => {
    card.addEventListener("dragstart", (e) => {
      e.stopPropagation();
      card.classList.add("dragging");
      e.dataTransfer.setData("text/plain", "card:" + card.dataset.cardId);
      e.dataTransfer.effectAllowed = "move";
    });
    card.addEventListener("dragend", () => card.classList.remove("dragging"));
  });

  app.querySelectorAll("[data-col-drag]").forEach((handle) => {
    handle.addEventListener("dragstart", (e) => {
      if (e.target.closest("[data-add-col-task], [data-rename-col-input], [data-collapse-col], .bc-menu-wrap")) { e.preventDefault(); return; }
      e.stopPropagation();
      e.dataTransfer.setData("text/plain", "col:" + handle.dataset.colDrag);
      e.dataTransfer.effectAllowed = "move";
      handle.closest(".board-col").classList.add("dragging");
    });
    handle.addEventListener("dragend", () => handle.closest(".board-col")?.classList.remove("dragging"));
  });

  app.querySelectorAll(".board-col").forEach((col) => {
    col.addEventListener("dragover", (e) => {
      e.preventDefault();
      col.classList.add("dragover");
    });
    col.addEventListener("dragleave", () => col.classList.remove("dragover"));
    col.addEventListener("drop", (e) => {
      e.preventDefault();
      col.classList.remove("dragover");
      const payload = e.dataTransfer.getData("text/plain");
      const colId = col.dataset.colId;
      if (payload.startsWith("col:")) {
        reorderColumns(ctx, payload.slice(4), colId, rerender);
        return;
      }
      handleCardDrop(ctx, payload.replace(/^card:/, ""), colId, rerender);
    });
  });

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

function reorderColumns(ctx, fromId, toId, rerender) {
  if (fromId === toId) return;
  const fromIdx = ctx.cols.findIndex((c) => c.id === fromId);
  const toIdx = ctx.cols.findIndex((c) => c.id === toId);
  if (fromIdx === -1 || toIdx === -1) return;
  pushHistory(ctx);
  const [moved] = ctx.cols.splice(fromIdx, 1);
  ctx.cols.splice(toIdx, 0, moved);
  ctx.save();
  rerender();
}

async function removeColumn(ctx, id, rerender) {
  if (id === ctx.cols[0]?.id) { toast(`"${ctx.cols[0].title}" can't be deleted — hide it instead`); return; }
  if (ctx.cols.length <= 1) { toast("Need at least one column"); return; }
  const col = ctx.cols.find((c) => c.id === id);
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

async function handleCardDrop(ctx, cardId, colId, rerender) {
  const s = sessions.find((x) => x.id === cardId);
  if (!s) return;
  const homeId = ctx.cols[0]?.id;
  const targetCol = ctx.cols.find((c) => c.id === colId);

  // dropping onto the home column ("All sessions") isn't a move — it clears whatever custom tag
  // this card has, since home always shows everyone regardless of tag
  if (colId === homeId) {
    if (boardTagFor(ctx, s) == null) { toast('Already shown in "All sessions"'); return; }
    pushHistory(ctx);
    rerender();
    await setBoardTag(ctx, cardId, null);
    return;
  }

  if (ctx.kind === "main" && targetCol?.cwd) {
    if (!s.isTicket) {
      // a session's project is fixed — dropping it on a DIFFERENT project's column is rejected;
      // dropping it on its OWN project column just clears any custom tag (it's already shown there)
      if (s.cwd !== targetCol.cwd) {
        toast(`Can't move — this session belongs to "${projectName(s.cwd)}", not "${projectName(targetCol.cwd)}"`);
        return;
      }
      if (boardTagFor(ctx, s) == null) { toast("Already shown on its own project column"); return; }
      pushHistory(ctx);
      rerender();
      await setBoardTag(ctx, cardId, null);
      return;
    }
    // a ticket has no fixed project — dropping it on a project column adopts that project as its
    // own (membership there is then computed from its cwd, same as a real session)
    pushHistory(ctx);
    s.cwd = targetCol.cwd;
    rerender();
    await patchMeta(cardId, { cwd: targetCol.cwd });
    await setBoardTag(ctx, cardId, null);
    return;
  }

  // a plain column (Priority/In Progress/Done/custom, on Main board or inside a project's own
  // board): tag it here — independently per board, never a shared/global placement
  pushHistory(ctx);
  rerender();
  await setBoardTag(ctx, cardId, colId);
}
