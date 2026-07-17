import { sessions, autoHideEmpty } from "../../state.js";
import { escapeHtml, escapeAttr, projectName } from "../../ui/format.js";
import { patchMeta } from "../../api/sessionsApi.js";
import { setBoardMode, enterProjectBoard, ensureAllProjectColumns } from "../../routing/boardRouting.js";
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

// A column's members are computed, not just bucketed once per card — a session can belong to
// several columns at the same time. The home column (cols[0], "All sessions") always shows
// everyone; on Main board, a column with a `.cwd` shows every card whose own cwd matches it,
// permanently (a session's project is fixed — dragging it elsewhere never removes it from here);
// every other column is a plain tag (`meta.board === column.id`), same as always.
function cardsForColumn(c, ctx, filtered, homeId) {
  if (c.id === homeId) return filtered;
  if (ctx.kind === "main" && c.cwd) return filtered.filter((s) => s.cwd === c.cwd);
  return filtered.filter((s) => s.meta?.board === c.id);
}

function missingProjectCount(ctx) {
  if (ctx.kind !== "main") return 0;
  const existing = new Set(ctx.cols.filter((c) => c.cwd).map((c) => c.cwd));
  return new Set(sessions.filter((s) => !s.isTicket && !existing.has(s.cwd)).map((s) => s.cwd)).size;
}

export function renderBoardView(filtered, ctx, breadcrumbHtml = "") {
  const app = document.getElementById("app");
  const homeId = ctx.cols[0]?.id;
  const menuOpen = isManageColumnsMenuOpen();
  const visibleCols = ctx.cols.filter((c) => {
    if (menuOpen) return true;
    if (c.hidden) return false;
    if (autoHideEmpty && c.id !== homeId && cardsForColumn(c, ctx, filtered, homeId).length === 0) return false;
    return true;
  });
  const hiddenCount = ctx.cols.filter((c) => c.hidden).length;

  const drift = missingProjectCount(ctx);

  // Every render fully replaces .board's innerHTML (new session data, a column edit, a 15s poll,
  // …) — without this, the browser resets scrollLeft to 0 each time, which reads as the board
  // "jerking back to start" mid-scroll. Same for each column's own vertical scroll.
  const prevScrollLeft = app.querySelector(".board")?.scrollLeft || 0;
  const prevColScrollTops = new Map();
  app.querySelectorAll(".board-col-body[data-col-drop]").forEach((el) => {
    prevColScrollTops.set(el.dataset.colDrop, el.scrollTop);
  });

  app.innerHTML = `
    ${breadcrumbHtml}
    ${agentsDockHtml()}
    <div class="board-actions">
      <button class="btn ghost" id="addColBtn">+ Add column</button>
      <span style="flex:1"></span>
      ${ctx.kind === "main" ? `
        <button class="btn accent" id="regroupBtn" title="${drift ? `${drift} project${drift === 1 ? "" : "s"} would get a column` : "Every project already has a column"}">
          ↻ Regroup by project${drift ? ` <span class="badge">${drift}</span>` : ""}
        </button>
        <button class="btn ghost" id="saveViewBtn" title="Save this column layout as a reusable view">＋ Save as view</button>` : ""}
      <button class="btn ghost" id="boardUndoBtn" ${hasHistoryFor(ctx) ? "" : "disabled"} title="Undo the last change to this board">↩ Undo</button>
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
        return `
        <div class="board-col${c.hidden ? " board-col-hidden" : ""}${c.fresh ? " new-col" : ""}" data-col-id="${c.id}">
          <div class="board-col-header" draggable="${!c.renaming}" data-col-drag="${c.id}" title="${c.cwd ? "Drag to reorder" : "Drag to reorder columns"}">
            <span class="drag-handle">⠿</span>
            ${titleHtml}
            <span class="board-count">${items.length}</span>
            <span class="col-add-btn" data-add-col-task="${c.id}" title="New task">+</span>
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

  document.getElementById("regroupBtn")?.addEventListener("click", () => ensureAllProjectColumns());
  document.getElementById("boardUndoBtn")?.addEventListener("click", () => undoLast(ctx));
  document.getElementById("saveViewBtn")?.addEventListener("click", async () => {
    const title = await openPromptModal({ title: "Save as view", label: "View name" });
    if (title && title.trim()) createSavedView(title.trim());
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

  document.getElementById("addColBtn")?.addEventListener("click", () => {
    pushHistory(ctx);
    const n = ctx.cols.filter((c) => !c.cwd).length + 1;
    const created = { id: "custom-" + Date.now(), title: "New column " + n, fresh: true, renaming: true };
    ctx.cols.push(created);
    rerender();
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
      if (e.target.closest("[data-add-col-task], [data-rename-col-input]")) { e.preventDefault(); return; }
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
  if (ctx.cols.length <= 1) { toast("Need at least one column"); return; }
  const col = ctx.cols.find((c) => c.id === id);
  const home = ctx.cols.find((c) => c.id !== id) || ctx.cols[0];
  const ok = await openConfirmModal({
    title: `Remove column "${col?.title}"?`,
    message: `Sessions tagged into it move back to "${home.title}".`,
    confirmLabel: "Remove",
    danger: true,
  });
  if (!ok) return;
  pushHistory(ctx);
  for (const s of sessions) {
    if (s.meta?.board === id) patchMeta(s.id, { board: null });
  }
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
    if (!s.meta?.board) { toast('Already shown in "All sessions"'); return; }
    pushHistory(ctx);
    rerender();
    await patchMeta(cardId, { board: null });
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
      if (!s.meta?.board) { toast("Already shown on its own project column"); return; }
      pushHistory(ctx);
      rerender();
      await patchMeta(cardId, { board: null });
      return;
    }
    // a ticket has no fixed project — dropping it on a project column adopts that project as its
    // own (membership there is then computed from its cwd, same as a real session)
    pushHistory(ctx);
    s.cwd = targetCol.cwd;
    rerender();
    await patchMeta(cardId, { cwd: targetCol.cwd, board: null });
    return;
  }

  // a plain column (Priority/In Progress/Done/custom, on Main board or inside a project's own
  // board): tag it here
  pushHistory(ctx);
  rerender();
  await patchMeta(cardId, { board: colId });
}
