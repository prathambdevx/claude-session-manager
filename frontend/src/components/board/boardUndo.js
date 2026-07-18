// Global undo for board-structure edits, scoped per board (ctx.kind + ctx.cwd) so undoing on Main
// board never touches a project board's history.
import { sessions, boardHistory, setBoardHistory } from "../../state.js";
import { toast } from "../../ui/toast.js";

const HISTORY_LIMIT = 30;

function ctxKey(ctx) {
  return ctx.kind === "main" ? "main" : `project:${ctx.cwd}`;
}

// Board tags live per-card server-side, not one shared blob — restoring a snapshot means replaying
// a patchMeta call per card whose tag actually changed.
function snapshotBoardTags() {
  const tags = {};
  for (const s of sessions) tags[s.id] = s.meta?.board;
  return tags;
}

export function pushHistory(ctx) {
  const entry = { key: ctxKey(ctx), columns: JSON.parse(JSON.stringify(ctx.cols)), tags: snapshotBoardTags() };
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

  const { patchMeta } = await import("../../api/sessionsApi.js");
  const jobs = [];
  for (const s of sessions) {
    const wasBoard = entry.tags[s.id];
    if ((s.meta?.board || undefined) !== (wasBoard || undefined)) jobs.push(patchMeta(s.id, { board: wasBoard || null }));
  }
  await Promise.all(jobs);

  toast("Undone");
  await import("../../pages/sessionsPage.js").then((m) => m.render());
}
