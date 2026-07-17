// Saved board views (named column-layout snapshots switchable from the sidebar) and small
// board-level display settings (default view, auto-hide-empty-columns) — both shared server-side
// across browsers like everything else here, not left in one browser's localStorage.
import {
  loadSavedViews, saveSavedViews, loadBoardSettings, saveBoardSettings,
} from "../store.ts";
import type { SavedView, BoardColumn } from "../store.ts";
import { json } from "./json.ts";

function cleanColumns(cols: any): BoardColumn[] | null {
  if (!Array.isArray(cols)) return null;
  return cols
    .filter((c: any) => c && typeof c.id === "string" && typeof c.title === "string")
    .map((c: any) => ({
      id: c.id.slice(0, 60), title: c.title.slice(0, 80),
      ...(c.cwd ? { cwd: String(c.cwd).slice(0, 500) } : {}),
      ...(c.hidden ? { hidden: true } : {}),
    }));
}

export async function handleSavedViewsRoutes(req: Request, url: URL): Promise<Response | null> {
  if (url.pathname === "/api/saved-views" && req.method === "GET") {
    return json({ views: await loadSavedViews() });
  }

  if (url.pathname === "/api/saved-views" && req.method === "POST") {
    const body = await req.json().catch(() => ({}));
    const title = String(body?.title ?? "").trim();
    if (!title) return json({ error: "title is required" }, { status: 400 });
    const columns = cleanColumns(body?.columns);
    if (!columns) return json({ error: "columns array required" }, { status: 400 });
    const views = await loadSavedViews();
    const view: SavedView = { id: crypto.randomUUID(), title: title.slice(0, 80), columns };
    views.push(view);
    await saveSavedViews(views);
    return json({ ok: true, view });
  }

  const viewMatch = url.pathname.match(/^\/api\/saved-views\/([^/]+)$/);
  if (viewMatch && req.method === "PUT") {
    const id = viewMatch[1];
    const views = await loadSavedViews();
    const view = views.find((v) => v.id === id);
    if (!view) return json({ error: "view not found" }, { status: 404 });
    const body = await req.json().catch(() => ({}));
    if (typeof body.title === "string" && body.title.trim()) view.title = body.title.trim().slice(0, 80);
    if (body.columns !== undefined) {
      const columns = cleanColumns(body.columns);
      if (!columns) return json({ error: "invalid columns array" }, { status: 400 });
      view.columns = columns;
    }
    await saveSavedViews(views);
    return json({ ok: true, view });
  }

  if (viewMatch && req.method === "DELETE") {
    const id = viewMatch[1];
    const views = await loadSavedViews();
    const next = views.filter((v) => v.id !== id);
    await saveSavedViews(next);
    return json({ ok: true });
  }

  if (url.pathname === "/api/board-settings" && req.method === "GET") {
    return json({ settings: await loadBoardSettings() });
  }

  if (url.pathname === "/api/board-settings" && req.method === "PUT") {
    const body = await req.json().catch(() => ({}));
    const current = await loadBoardSettings();
    const next = { ...current };
    if ("defaultViewId" in body) next.defaultViewId = body.defaultViewId ? String(body.defaultViewId).slice(0, 120) : undefined;
    if ("autoHideEmpty" in body) next.autoHideEmpty = Boolean(body.autoHideEmpty);
    await saveBoardSettings(next);
    return json({ ok: true, settings: next });
  }

  return null;
}
