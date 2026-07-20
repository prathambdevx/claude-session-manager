// The "Save as view" flow: snapshot both the columns and the session-to-column placements
// currently on screen into a new, self-contained saved view with no active filter of its own.
import { savedViews, sessions } from "../../state.js";
import { boardTagFor, setBoardTag } from "../../routing/boardRouting.js";
import { projectName } from "../../ui/format.js";
import { openPromptModal } from "../../ui/promptModal.js";
import { createSavedView } from "../../api/savedViewsApi.js";

/** Core engine: maps the on-screen columns to filter-independent saved-view columns (see inline notes). */
export function snapshotColumns(visibleCols, ctx, { homeId, homeBorrowsProjectName, projectFilter }) {
  return visibleCols.map((c) => {
    // everything passed in is visible on screen, so drop hidden — a column only force-shown by the
    // active filter still carries hidden:true, which the filter-less saved view would otherwise honor
    const { hidden, ...col } = c;
    if (col.id !== homeId) return col;
    // home here is showing exactly one project (filtered Main board, or a project board) — bake it
    // into a real cwd column, dropping isAll so it stays scoped to that project, not "all sessions"
    const scopeCwd = ctx.kind === "project" ? ctx.cwd : (homeBorrowsProjectName ? projectFilter : null);
    if (!scopeCwd) return col;
    const { isAll, ...rest } = col;
    return { ...rest, cwd: scopeCwd, title: projectName(scopeCwd) };
  });
}

// Names the built-in sidebar entries already occupy — a saved view can't shadow either of them.
const RESERVED_VIEW_NAMES = ["main board", "all projects"];

/** Prompts for a name, then persists a snapshot of both the columns and card placements on screen. */
export async function openSaveViewModal(visibleCols, ctx, opts) {
  const title = await openPromptModal({
    title: "Save as view", label: "View name",
    validate: (v) => {
      const norm = v.trim().toLowerCase();
      if (RESERVED_VIEW_NAMES.includes(norm) || savedViews.some((view) => view.title.trim().toLowerCase() === norm)) {
        return `A view named "${v.trim()}" already exists`;
      }
      if (sessions.some((s) => s.cwd && projectName(s.cwd).trim().toLowerCase() === norm)) {
        return `A project named "${v.trim()}" already exists`;
      }
      return null;
    },
  });
  if (!title || !title.trim()) return;
  const columns = snapshotColumns(visibleCols, ctx, opts);
  const data = await createSavedView(title.trim(), columns);
  if (!data.ok) return;
  // Custom-column placement is stored per board context (boardTags, keyed by ctxKey) — the new
  // view has no entries of its own yet, so copy over every card currently sitting in one of these
  // columns explicitly. Home/project columns need nothing copied — their membership is computed.
  const customColIds = new Set(columns.filter((c) => c.id !== opts.homeId && !c.cwd).map((c) => c.id));
  const newViewCtx = { viewId: data.view.id };
  for (const s of sessions) {
    const tag = boardTagFor(ctx, s);
    if (tag != null && customColIds.has(tag)) setBoardTag(newViewCtx, s.id, tag, s.isTicket);
  }
}
