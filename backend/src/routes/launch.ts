import { existsSync } from "node:fs";
import { KNOWN_MODELS, LAUNCH_MODES } from "../config.ts";
import { loadMeta, saveMeta } from "../store.ts";
import { buildLaunchScript, openTerminalRunning, writeGhosttyTitle, ghosttyWindowTitle, ghosttyTitleFilePath } from "../claude/index.ts";
import { json } from "./json.ts";

export async function handleLaunchRoutes(req: Request, url: URL): Promise<Response | null> {
  if (url.pathname === "/api/launch" && req.method === "POST") {
    const body = await req.json().catch(() => ({}));
    const cwd = String(body?.cwd ?? "").trim();
    const task = String(body?.task ?? "").trim();
    const mode = LAUNCH_MODES.has(body?.mode) ? body.mode : "solo";
    const model = KNOWN_MODELS.has(body?.model) ? body.model : null;
    const name = String(body?.name ?? "").trim();
    const dangerous = body?.dangerous !== false;
    if (!cwd || !existsSync(cwd)) return json({ error: "unknown project directory" }, { status: 400 });
    if (!task) return json({ error: "task is required" }, { status: 400 });
    const sessionId = crypto.randomUUID();
    const script = buildLaunchScript(task, mode, { model, sessionId, dangerous });
    // wire the title-refresh loop up from the very first launch (not just a later Resume) — same
    // window title-polling mechanism as the resume route, otherwise a rename before the first
    // resume/reopen has no running loop to pick it up and silently does nothing
    await writeGhosttyTitle(sessionId, ghosttyWindowTitle(name || task, sessionId));
    await openTerminalRunning(cwd, script, { ghosttyTitleFile: ghosttyTitleFilePath(sessionId) });
    if (name) {
      const meta = await loadMeta();
      meta[sessionId] = { ...meta[sessionId], name };
      await saveMeta(meta);
    }
    return json({ ok: true, cwd, mode, sessionId });
  }

  return null;
}
