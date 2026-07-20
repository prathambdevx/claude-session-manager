// Board column state + the URL routing state machine. The URL (not localStorage) is the source of
// truth for which view is showing, so a refresh/back/forward stays put:
//   "/"                = All Projects (the group lens) — default landing page
//   "/views/<id>"      = a saved view
// Any other/legacy path (old "/projects" or "/projects/<cwd>" bookmarks) falls back to "/".
import { groupBoardColumns, setGroupBoardColumns, setActiveView, activeView, sessions, savedViews } from "../state.js";
import { projectName } from "../ui/format.js";

export function projectColumnId(cwd) {
  return "proj-" + projectName(cwd).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
}

const STALE_PROJECT_MS = 14 * 24 * 60 * 60 * 1000;

// Most recent lastActive among a project's own sessions — 0 if it has none (never sorts first,
// never counts as stale-but-active).
export function projectRecency(cwd, sessionList) {
  let max = 0;
  for (const s of sessionList) if (s.cwd === cwd && s.lastActive > max) max = s.lastActive;
  return max;
}

// Appends a column for any project cwd not already represented, leaving every existing column
// untouched. Idempotent — safe to call even when nothing needs to change. A newly added column
// for a project untouched in 14+ days starts collapsed — an already-existing column's collapsed
// state is never touched here, so a manual expand/collapse survives a later re-run.
export function mergeInProjectColumns(cols, sessionList) {
  const existingCwds = new Set(cols.filter((c) => c.cwd).map((c) => c.cwd));
  // isProjectDir (backend/src/sessions/projectDetection.ts) keeps a scratch/temp cwd from ever
  // getting its own auto-added column — an existing column for one is left alone, never removed.
  const cwds = [...new Set(sessionList.filter((s) => s.cwd && s.isProjectDir && !existingCwds.has(s.cwd)).map((s) => s.cwd))]
    .sort((a, b) => projectName(a).localeCompare(projectName(b)));
  if (!cwds.length) return { columns: cols, changed: false };
  const seenIds = new Set(cols.map((c) => c.id));
  const now = Date.now();
  const added = cwds.map((cwd) => {
    let id = projectColumnId(cwd);
    let n = 2;
    while (seenIds.has(id)) id = `${projectColumnId(cwd)}-${n++}`; // dedupe two dirs sharing a basename
    seenIds.add(id);
    const lastActive = projectRecency(cwd, sessionList);
    const stale = lastActive > 0 && now - lastActive > STALE_PROJECT_MS;
    return { id, title: projectName(cwd), cwd, ...(stale ? { collapsed: true } : {}) };
  });
  return { columns: [...cols, ...added], changed: true };
}

// Derives the current view from the URL — "/" and any legacy "/projects*" link both land on the
// group lens, so an old bookmark degrades gracefully instead of 404ing.
export function parseView() {
  const view = location.pathname.match(/^\/views\/(.+)$/);
  return view ? "saved:" + decodeURIComponent(view[1]) : "group";
}

// The URL a given view should live at — inverse of parseView.
export function pathForView(view) {
  return view?.startsWith("saved:") ? "/views/" + encodeURIComponent(view.slice(6)) : "/";
}

// Called once at boot (main.js) to seed state.js's activeView from the current URL.
export function initBoardStateFromLocation() {
  setActiveView(parseView());
}

// Canonical view navigation: updates state, pushes the matching URL, and re-renders.
export async function switchToView(view) {
  setActiveView(view);
  history.pushState({}, "", pathForView(view));
  await import("../pages/sessionsPage.js").then((m) => m.render());
}

// The saved view the URL currently points at, or undefined if it's been deleted (or activeView
// isn't a saved view at all) — the one place every other module resolves this instead of
// re-deriving activeView.slice(6) themselves.
export function currentSavedView() {
  return activeView.startsWith("saved:") ? savedViews.find((v) => v.id === activeView.slice(6)) : undefined;
}

// Creates a brand-new, empty view and switches straight into it — no snapshot step, unlike the
// old "Save as view" flow this replaces.
export async function createView() {
  const { createSavedView } = await import("../api/savedViewsApi.js");
  const data = await createSavedView(`Untitled view ${savedViews.length + 1}`, []);
  if (data.ok) await switchToView("saved:" + data.view.id);
}

// The "All Projects" lens — auto-seeded with one column per project (see loadSessions), then
// manageable exactly like a saved view's project columns: draggable, hideable, renameable.
export function groupBoardCtx() {
  return {
    kind: "group",
    get cols() { return groupBoardColumns; },
    set cols(v) { setGroupBoardColumns(v); },
    save: () => import("../api/sessionsApi.js").then((m) => m.saveGroupBoardColumns()),
  };
}

// A saved view renders through the same board UI as the group lens (kind:"main"), but edits
// persist to its own column snapshot. viewId is what lets ctxKey give each saved view its own slot.
export function savedViewCtx(view) {
  const id = view.id;
  // Resolve fresh by id on every access, never close over the passed-in object — a poll can swap
  // savedViews for new objects between renders, orphaning a captured reference silently.
  const live = () => savedViews.find((v) => v.id === id);
  return {
    kind: "main",
    viewId: id,
    get cols() { return live()?.columns ?? []; },
    set cols(v) { const cur = live(); if (cur) cur.columns = v; },
    save: () => import("../api/savedViewsApi.js").then((m) => m.saveSavedViewColumns(id, live()?.columns ?? [])),
  };
}

// Identifies which board a custom-column card placement belongs to — the group lens or a saved
// view each get their own independent slot in a card's boardTags map.
export function ctxKey(ctx) {
  return ctx.viewId ? `saved:${ctx.viewId}` : "group";
}

// board (the legacy flat field) is read as a fallback for every context — every board/view
// historically shared that one field indiscriminately, so a view that already had cards tagged
// before boardTags existed must keep seeing them. Once a card gets tagged in a specific context
// going forward, its boardTags entry for that key takes over and this fallback is no longer
// consulted for it.
export function boardTagFor(ctx, s) {
  const fromMap = s.meta?.boardTags?.[ctxKey(ctx)];
  if (fromMap !== undefined) return fromMap;
  return s.meta?.board ?? null;
}

// isTicket overrides the sessions-array lookup — needed right after creating a new ticket (or
// session), when it hasn't landed in local state yet (loadSessions() runs after this call, not
// before) — "not found locally" alone can't tell a brand-new ticket from a brand-new session.
export async function setBoardTag(ctx, cardId, colId, isTicket) {
  const s = sessions.find((x) => x.id === cardId);
  // Tickets live in their own store (data/tickets/), not meta.json — patchMeta's PUT
  // /api/sessions/:id/meta silently writes to the wrong place for one (no such session exists),
  // so a ticket's tag never persisted anywhere the board actually reads it.
  if (isTicket ?? s?.isTicket) {
    if (s) {
      // already loaded (e.g. being dragged) — update local state and render immediately, same as
      // patchMeta, so it moves on drop instead of waiting for the round-trip to finish
      s.meta = { ...s.meta, boardTags: { ...s.meta?.boardTags, [ctxKey(ctx)]: colId } };
      await import("../pages/sessionsPage.js").then((m) => m.render());
    }
    await fetch(`/api/tickets/${cardId}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ boardTags: { [ctxKey(ctx)]: colId } }),
    });
    return;
  }
  const { patchMeta } = await import("../api/sessionsApi.js");
  await patchMeta(cardId, { boardTags: { [ctxKey(ctx)]: colId } });
}

// browser back/forward — re-derive state from the URL bar rather than trusting popstate's
// event.state (works even if the user typed/edited the URL directly, not just navigated via it)
export function wirePopstate() {
  window.addEventListener("popstate", () => {
    setActiveView(parseView());
    import("../pages/sessionsPage.js").then((m) => m.render());
  });
}
