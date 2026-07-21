import { existsSync } from "node:fs";
import { KNOWN_MODELS } from "../constants.ts";
import { loadMeta, saveMeta } from "../store.ts";
import { buildLaunchScript, grids, paneArgv, openTerminalForGrid } from "../claude/index.ts";
import { json } from "./json.ts";

export async function handleLaunchRoutes(req: Request, url: URL): Promise<Response | null> {
  if (url.pathname === "/api/launch" && req.method === "POST") {
    const body = await req.json().catch(() => ({}));
    const cwd = String(body?.cwd ?? "").trim();
    const task = String(body?.task ?? "").trim();
    const model = KNOWN_MODELS.has(body?.model) ? body.model : null;
    const name = String(body?.name ?? "").trim();
    const dangerous = body?.dangerous !== false;
    if (!cwd || !existsSync(cwd)) return json({ error: "unknown project directory" }, { status: 400 });
    if (!task) return json({ error: "task is required" }, { status: 400 });

    const sessionId = crypto.randomUUID();
    const script = buildLaunchScript(task, { model, sessionId, dangerous });
    const opened = grids.openOrCreate(sessionId, paneArgv(script), cwd, name || task.slice(0, 50));
    if (!opened) return json({ error: "failed to start tmux session — is tmux installed?" }, { status: 500 });
    if (process.platform === "darwin" && opened.needsTerminal) openTerminalForGrid(`csm-grid-${opened.gridId}`);

    if (name) {
      const meta = await loadMeta();
      meta[sessionId] = { ...meta[sessionId], name };
      await saveMeta(meta);
    }
    return json({ ok: true, cwd, sessionId });
  }

  return null;
}
