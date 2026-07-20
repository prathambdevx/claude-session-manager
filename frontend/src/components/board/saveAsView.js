// The "Save as view" flow: snapshot the columns currently on screen into a new, self-contained
// saved view that reproduces the same board even though a saved view carries no active filter.
import { savedViews, sessions } from "../../state.js";
import { projectName } from "../../ui/format.js";
import { openPromptModal } from "../../ui/promptModal.js";
import { createSavedView } from "../../api/savedViewsApi.js";

/** Core engine: maps the on-screen columns to filter-independent saved-view columns (see inline notes). */
export function snapshotColumns(visibleCols, { kind, cwd, homeId, homeBorrowsProjectName, projectFilter }) {
  return visibleCols.map((c) => {
    // everything passed in is visible on screen, so drop hidden — a column only force-shown by the
    // active filter still carries hidden:true, which the filter-less saved view would otherwise honor
    const { hidden, ...col } = c;
    if (col.id !== homeId) return col;
    // home here is showing exactly one project (filtered Main board, or a project board) — bake it
    // into a real cwd column, dropping isAll so it stays scoped to that project, not "all sessions"
    const scopeCwd = kind === "project" ? cwd : (homeBorrowsProjectName ? projectFilter : null);
    if (!scopeCwd) return col;
    const { isAll, ...rest } = col;
    return { ...rest, cwd: scopeCwd, title: projectName(scopeCwd) };
  });
}

/** Prompts for a name, then persists a snapshot of the given on-screen columns as a new saved view. */
// Names the built-in sidebar entries already occupy — a saved view can't shadow either of them.
const RESERVED_VIEW_NAMES = ["main board", "all projects"];

export async function openSaveViewModal(visibleCols, opts) {
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
  createSavedView(title.trim(), snapshotColumns(visibleCols, opts));
}
