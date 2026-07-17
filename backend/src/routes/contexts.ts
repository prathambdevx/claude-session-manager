import { join } from "node:path";
import { PROJECTS_DIR, KNOWN_MODELS } from "../config.ts";
import { loadMeta, saveMeta, saveContext, loadContext } from "../store.ts";
import type { ContextRecord } from "../store.ts";
import { scanAllSessions, buildTranscriptDigest } from "../sessions.ts";
import { runClaudeHeadless, buildContextExtractionPrompt, buildContinuationPrompt, buildLaunchScript, openTerminalRunning } from "../claude.ts";
import { markdownToHtml } from "../html.ts";
import { json } from "./json.ts";

export async function handleContextsRoutes(req: Request, url: URL): Promise<Response | null> {
  const extractMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/extract-context$/);
  if (extractMatch && req.method === "POST") {
    const id = extractMatch[1];
    const body = await req.json().catch(() => ({}));
    const model = KNOWN_MODELS.has(body?.model) ? body.model : null;
    const sessions = await scanAllSessions();
    const s = sessions.find((x) => x.id === id);
    if (!s) return json({ error: "session not found" }, { status: 404 });
    const transcriptPath = join(PROJECTS_DIR, s.projectSlug, `${id}.jsonl`);
    try {
      const digest = await buildTranscriptDigest(transcriptPath);
      const markdown = await runClaudeHeadless(buildContextExtractionPrompt(digest), {
        cwd: s.cwd,
        model: model || "sonnet",
        tools: "", // pure text-in/text-out — no file access needed, we already built the digest ourselves
        timeoutMs: 90000,
      });
      const contextId = crypto.randomUUID();
      const ctx: ContextRecord = { id: contextId, sessionId: id, cwd: s.cwd, model, createdAt: Date.now(), markdown };
      await saveContext(ctx);
      const meta = await loadMeta();
      meta[id] = { ...meta[id], lastContextId: contextId };
      await saveMeta(meta);
      return json({ ok: true, contextId });
    } catch (e: any) {
      return json({ error: e?.message ?? "context extraction failed" }, { status: 500 });
    }
  }

  const contextGetMatch = url.pathname.match(/^\/api\/contexts\/([^/]+)$/);
  if (contextGetMatch && req.method === "GET") {
    const ctx = await loadContext(contextGetMatch[1]);
    if (!ctx) return json({ error: "context not found" }, { status: 404 });
    return json({ context: ctx });
  }

  const contextPageMatch = url.pathname.match(/^\/contexts\/([^/]+)$/);
  if (contextPageMatch && req.method === "GET") {
    const ctx = await loadContext(contextPageMatch[1]);
    if (!ctx) return new Response("Context not found", { status: 404 });
    return new Response(markdownToHtml(ctx.markdown, "Context points"), { headers: { "Content-Type": "text/html; charset=utf-8" } });
  }

  const contextStartMatch = url.pathname.match(/^\/api\/contexts\/([^/]+)\/start$/);
  if (contextStartMatch && req.method === "POST") {
    const ctx = await loadContext(contextStartMatch[1]);
    if (!ctx) return json({ error: "context not found" }, { status: 404 });
    const body = await req.json().catch(() => ({}));
    const model = KNOWN_MODELS.has(body?.model) ? body.model : null;
    const name = String(body?.name ?? "").trim();
    const dangerous = body?.dangerous !== false;
    const newSessionId = crypto.randomUUID();
    const script = buildLaunchScript(buildContinuationPrompt(ctx), "solo", { model, sessionId: newSessionId, dangerous });
    await openTerminalRunning(ctx.cwd, script);
    if (name) {
      const meta = await loadMeta();
      meta[newSessionId] = { ...meta[newSessionId], name };
      await saveMeta(meta);
    }
    return json({ ok: true, cwd: ctx.cwd, sessionId: newSessionId });
  }

  return null;
}
