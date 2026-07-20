// Board columns (server-side, shared across browsers): the main board, the todo board, and
// per-project boards (each project cwd gets its own independent column set).
import { saveBoard, saveTodoBoard, saveGroupBoard, loadProjectBoards, saveProjectBoards } from "../store.ts";
import { json } from "./json.ts";

export async function handleBoardRoutes(req: Request, url: URL): Promise<Response | null> {
  if (url.pathname === "/api/board" && req.method === "PUT") {
    const body = await req.json().catch(() => ({}));
    const cols = Array.isArray(body?.columns) ? body.columns : null;
    if (!cols) return json({ error: "columns array required" }, { status: 400 });
    const clean = cols
      .filter((c: any) => c && typeof c.id === "string" && typeof c.title === "string")
      .map((c: any) => ({
        id: c.id.slice(0, 60), title: c.title.slice(0, 80),
        ...(c.cwd ? { cwd: String(c.cwd).slice(0, 500) } : {}),
        ...(c.hidden ? { hidden: true } : {}),
        ...(c.collapsed ? { collapsed: true } : {}),
        ...(c.neverPopulated ? { neverPopulated: true } : {}),
        ...(c.isAll ? { isAll: true } : {}),
      }));
    await saveBoard(clean);
    return json({ ok: true, columns: clean });
  }

  if (url.pathname === "/api/group-board" && req.method === "PUT") {
    const body = await req.json().catch(() => ({}));
    const cols = Array.isArray(body?.columns) ? body.columns : null;
    if (!cols) return json({ error: "columns array required" }, { status: 400 });
    const clean = cols
      .filter((c: any) => c && typeof c.id === "string" && typeof c.title === "string")
      .map((c: any) => ({
        id: c.id.slice(0, 60), title: c.title.slice(0, 80),
        ...(c.cwd ? { cwd: String(c.cwd).slice(0, 500) } : {}),
        ...(c.hidden ? { hidden: true } : {}),
        ...(c.collapsed ? { collapsed: true } : {}),
        ...(c.neverPopulated ? { neverPopulated: true } : {}),
      }));
    await saveGroupBoard(clean);
    return json({ ok: true, columns: clean });
  }

  if (url.pathname === "/api/todo-board" && req.method === "PUT") {
    const body = await req.json().catch(() => ({}));
    const cols = Array.isArray(body?.columns) ? body.columns : null;
    if (!cols) return json({ error: "columns array required" }, { status: 400 });
    const clean = cols
      .filter((c: any) => c && typeof c.id === "string" && typeof c.title === "string")
      .map((c: any) => ({ id: c.id.slice(0, 60), title: c.title.slice(0, 80) }));
    await saveTodoBoard(clean);
    return json({ ok: true, columns: clean });
  }

  if (url.pathname === "/api/project-board" && req.method === "PUT") {
    const body = await req.json().catch(() => ({}));
    const cwd = String(body?.cwd ?? "").trim().slice(0, 500);
    if (!cwd) return json({ error: "cwd required" }, { status: 400 });
    const cols = Array.isArray(body?.columns) ? body.columns : null;
    if (!cols) return json({ error: "columns array required" }, { status: 400 });
    const clean = cols
      .filter((c: any) => c && typeof c.id === "string" && typeof c.title === "string")
      .map((c: any) => ({
        id: c.id.slice(0, 60), title: c.title.slice(0, 80),
        ...(c.hidden ? { hidden: true } : {}),
        ...(c.collapsed ? { collapsed: true } : {}),
        ...(c.neverPopulated ? { neverPopulated: true } : {}),
        ...(c.isAll ? { isAll: true } : {}),
      }));
    const all = await loadProjectBoards();
    all[cwd] = clean;
    await saveProjectBoards(all);
    return json({ ok: true, columns: clean });
  }

  return null;
}
