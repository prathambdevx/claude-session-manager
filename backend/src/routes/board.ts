// Board columns (server-side, shared across browsers): the "All Projects" lens and the todo board.
import { saveTodoBoard, saveGroupBoard } from "../store.ts";
import { json } from "./json.ts";

export async function handleBoardRoutes(req: Request, url: URL): Promise<Response | null> {
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

  return null;
}
