// Global undo for board-structure edits, scoped per board (ctxKey) so undoing on the group lens
// never touches a saved view's own history, or vice versa.
import { sessions, boardHistory, setBoardHistory } from "../../state.js";
import { toast } from "../../ui/toast.js";
import { ctxKey, boardTagFor, setBoardTag } from "../../routing/boardRouting.js";

const HISTORY_LIMIT = 30;

// Board tags live per-card server-side, not one shared blob — restoring a snapshot means replaying
// a setBoardTag call per card whose tag (in THIS board's own slot) actually changed.
function snapshotBoardTags(ctx) {
  const tags = {};
  for (const s of sessions) tags[s.id] = boardTagFor(ctx, s);
  return tags;
}

export function pushHistory(ctx) {
  const entry = { key: ctxKey(ctx), columns: JSON.parse(JSON.stringify(ctx.cols)), tags: snapshotBoardTags(ctx) };
  const next = [...boardHistory, entry];
  if (next.length > HISTORY_LIMIT) next.shift();
  setBoardHistory(next);
}

export function hasHistoryFor(ctx) {
  const key = ctxKey(ctx);
  return boardHistory.some((h) => h.key === key);
}

export async function undoLast(ctx) {
  const key = ctxKey(ctx);
  const idx = boardHistory.map((h) => h.key).lastIndexOf(key);
  if (idx === -1) { toast("Nothing to undo yet"); return; }
  const entry = boardHistory[idx];
  setBoardHistory(boardHistory.filter((_, i) => i !== idx));

  ctx.cols = entry.columns;
  await ctx.save();

  const jobs = [];
  for (const s of sessions) {
    const wasTag = entry.tags[s.id] ?? null;
    if (boardTagFor(ctx, s) !== wasTag) jobs.push(setBoardTag(ctx, s.id, wasTag));
  }
  await Promise.all(jobs);

  toast("Undone");
  await import("../../pages/sessionsPage.js").then((m) => m.render());
}
