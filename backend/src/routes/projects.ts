import { scanAllSessions } from "../sessions.ts";
import { json } from "./json.ts";

export async function handleProjectsRoutes(req: Request, url: URL): Promise<Response | null> {
  if (url.pathname === "/api/projects" && req.method === "GET") {
    const sessions = await scanAllSessions();
    const cwds = [...new Set(sessions.map((s) => s.cwd))].sort();
    return json({ projects: cwds });
  }

  return null;
}
