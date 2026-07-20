// Drag & drop wiring for the board: cards move between columns, column headers reorder columns.
// Split out of renderBoardView.js once it grew past ~250 lines.
import { sessions } from "../../state.js";
import { boardTagFor, setBoardTag } from "../../routing/boardRouting.js";
import { toast } from "../../ui/toast.js";
import { projectName } from "../../ui/format.js";
import { pushHistory } from "./boardUndo.js";

export function reorderColumns(ctx, fromId, toId, rerender) {
  if (fromId === toId) return;
  // The home column stays pinned first while it's actually shown — hidden, there's nothing to
  // pin, so the remaining visible columns reorder freely (including whichever is now first).
  const home = ctx.cols.find((c) => c.isAll);
  if (home && !home.hidden && (fromId === home.id || toId === home.id)) {
    toast(`"${home.title}" always stays first`);
    return;
  }
  const fromIdx = ctx.cols.findIndex((c) => c.id === fromId);
  const toIdx = ctx.cols.findIndex((c) => c.id === toId);
  if (fromIdx === -1 || toIdx === -1) return;
  pushHistory(ctx);
  const [moved] = ctx.cols.splice(fromIdx, 1);
  ctx.cols.splice(toIdx, 0, moved);
  ctx.save();
  rerender();
}

async function handleCardDrop(ctx, cardId, colId, rerender) {
  const s = sessions.find((x) => x.id === cardId);
  if (!s) return;
  const homeId = ctx.cols.find((c) => c.isAll)?.id ?? null;
  const targetCol = ctx.cols.find((c) => c.id === colId);

  // dropping onto the home column ("All sessions") isn't a move — it clears whatever custom tag
  // this card has, since home always shows everyone regardless of tag. Tickets are work items, not
  // real Claude sessions, so they're not part of "every session" at all — never allowed there.
  if (colId === homeId) {
    if (s.isTicket) { toast('Tickets can\'t move to "All sessions" — it\'s for real sessions only'); return; }
    if (boardTagFor(ctx, s) == null) { toast('Already shown in "All sessions"'); return; }
    pushHistory(ctx);
    rerender();
    await setBoardTag(ctx, cardId, null);
    return;
  }

  if (ctx.kind === "main" && targetCol?.cwd) {
    // a ticket has no fixed project of its own — it never belongs on a project-dedicated column,
    // same as it never belongs on "All sessions".
    if (s.isTicket) { toast("Tickets can't be moved onto a project column"); return; }
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

  // a plain column (Priority/In Progress/Done/custom, on Main board or inside a project's own
  // board): tag it here — independently per board, never a shared/global placement
  pushHistory(ctx);
  rerender();
  await setBoardTag(ctx, cardId, colId);
}

// A fully transparent 1x1 image — handed to setDragImage so the browser's own default ghost
// (just a snapshot of whatever element is draggable, i.e. the column header alone) never shows;
// the floating clone below is the only visible drag preview.
const BLANK_DRAG_IMAGE = new Image();
BLANK_DRAG_IMAGE.src = "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBTAA7";

let floatingClone = null;
let cloneOffsetX = 0;
let cloneOffsetY = 0;

function startColumnDragPreview(col, clientX, clientY) {
  const rect = col.getBoundingClientRect();
  cloneOffsetX = clientX - rect.left;
  cloneOffsetY = clientY - rect.top;
  const clone = col.cloneNode(true);
  clone.style.position = "fixed";
  clone.style.left = rect.left + "px";
  clone.style.top = rect.top + "px";
  clone.style.width = rect.width + "px";
  clone.style.height = rect.height + "px";
  clone.style.margin = "0";
  clone.style.pointerEvents = "none";
  clone.style.zIndex = "9999";
  clone.style.opacity = "0.9";
  clone.style.boxShadow = "0 12px 28px rgba(0,0,0,0.35)";
  document.body.appendChild(clone);
  floatingClone = clone;
}

function moveColumnDragPreview(clientX, clientY) {
  if (!floatingClone || (clientX === 0 && clientY === 0)) return; // a trailing dragend-adjacent event can report (0,0)
  floatingClone.style.left = (clientX - cloneOffsetX) + "px";
  floatingClone.style.top = (clientY - cloneOffsetY) + "px";
}

function endColumnDragPreview() {
  floatingClone?.remove();
  floatingClone = null;
}

// Auto-scrolls the board horizontally when a drag (card or column) nears its left/right edge, so
// columns off-screen are reachable without needing to drop, scroll, and re-drag.
const EDGE_ZONE_PX = 70;
const SCROLL_STEP_PX = 22;
function wireEdgeAutoScroll(board) {
  board.addEventListener("dragover", (e) => {
    const rect = board.getBoundingClientRect();
    const fromLeft = e.clientX - rect.left;
    const fromRight = rect.right - e.clientX;
    if (fromLeft < EDGE_ZONE_PX) board.scrollLeft -= SCROLL_STEP_PX;
    else if (fromRight < EDGE_ZONE_PX) board.scrollLeft += SCROLL_STEP_PX;
  });
}

export function wireBoardDragDrop(app, ctx, rerender) {
  const board = app.querySelector(".board");
  if (board) wireEdgeAutoScroll(board);

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
      e.dataTransfer.setDragImage(BLANK_DRAG_IMAGE, 0, 0);
      const col = handle.closest(".board-col");
      col.classList.add("dragging");
      startColumnDragPreview(col, e.clientX, e.clientY);
    });
    handle.addEventListener("drag", (e) => moveColumnDragPreview(e.clientX, e.clientY));
    handle.addEventListener("dragend", () => {
      handle.closest(".board-col")?.classList.remove("dragging");
      endColumnDragPreview();
    });
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
}
