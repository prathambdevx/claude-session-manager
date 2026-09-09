// Lets a moved project's historical sessions keep resolving without a real filesystem symlink —
// remaps oldPath to newPath for every future scan (see scanAllSessions, sessions/index.ts).
import { existsSync } from "node:fs";
import { loadProjectPathAliases, saveProjectPathAliases } from "../store.ts";
import { json } from "./json.ts";

export async function handleProjectAliasesRoutes(req: Request, url: URL): Promise<Response | null> {
  if (url.pathname === "/api/project-aliases" && req.method === "GET") {
    return json({ aliases: await loadProjectPathAliases() });
  }

  if (url.pathname === "/api/project-aliases" && req.method === "POST") {
    const body = await req.json().catch(() => ({}));
    const oldPath = String(body?.oldPath ?? "").trim();
    const newPath = String(body?.newPath ?? "").trim();
    if (!oldPath || !newPath) return json({ error: "oldPath and newPath are required" }, { status: 400 });
    if (!existsSync(newPath)) return json({ error: "newPath does not exist" }, { status: 400 });
    const aliases = await loadProjectPathAliases();
    aliases[oldPath] = newPath;
    await saveProjectPathAliases(aliases);
    return json({ ok: true, aliases });
  }

  if (url.pathname === "/api/project-aliases" && req.method === "DELETE") {
    const body = await req.json().catch(() => ({}));
    const oldPath = String(body?.oldPath ?? "").trim();
    const aliases = await loadProjectPathAliases();
    delete aliases[oldPath];
    await saveProjectPathAliases(aliases);
    return json({ ok: true, aliases });
  }

  return null;
}
