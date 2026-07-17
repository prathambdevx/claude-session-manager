import { join } from "node:path";
import { PROJECTS_DIR } from "../config.ts";
import { loadAgents, loadMeta, saveDelegation, loadDelegation, loadAllDelegations, deleteDelegation } from "../store.ts";
import type { Delegation } from "../store.ts";
import { scanAllSessions, buildTranscriptDigest } from "../sessions.ts";
import { runClaudeHeadlessDetached, buildDelegationPrompt } from "../claude/index.ts";
import { escapeHtmlServer, markdownToHtml, delegationsIndexHtml } from "../html.ts";
import { json } from "./json.ts";

export async function handleDelegationsRoutes(req: Request, url: URL): Promise<Response | null> {
  if (url.pathname === "/api/delegations" && req.method === "POST") {
    const body = await req.json().catch(() => ({}));
    const agentId = String(body?.agentId ?? "");
    const sessionId = String(body?.sessionId ?? "");
    const agents = await loadAgents();
    const agent = agents[agentId];
    if (!agent) return json({ error: "agent not found" }, { status: 404 });
    const sessions = await scanAllSessions();
    const s = sessions.find((x) => x.id === sessionId);
    if (!s) return json({ error: "session not found" }, { status: 404 });

    const meta = await loadMeta();
    const label = meta[s.id]?.name || meta[s.id]?.description || s.firstMessage || sessionId.slice(0, 8);
    const briefing = await buildTranscriptDigest(join(PROJECTS_DIR, s.projectSlug, `${sessionId}.jsonl`));
    const prompt = buildDelegationPrompt(agent, briefing, s.changedFiles);

    const id = crypto.randomUUID();
    const record: Delegation = {
      id,
      agentId,
      agentName: agent.name,
      agentEmoji: agent.emoji,
      sessionId,
      sessionLabel: label.slice(0, 100),
      cwd: s.cwd,
      status: "running",
      createdAt: Date.now(),
      finishedAt: null,
      result: null,
      error: null,
      pid: null,
      progress: [],
    };
    await saveDelegation(record); // persist "running" before spawning, so it's visible immediately

    const pid = runClaudeHeadlessDetached(
      prompt,
      { cwd: s.cwd, model: agent.model, permission: agent.permission },
      {
        onProgress: (activity) => {
          record.progress = activity;
          saveDelegation(record); // live feed; fire-and-forget write (throttled by the runner)
        },
        onClose: async (outcome) => {
          // persist the terminal state; source of truth is the file, so this survives even if unpolled
          const finished: Delegation = {
            ...record,
            status: outcome.ok ? "done" : "error",
            finishedAt: Date.now(),
            result: outcome.ok ? outcome.output || "(agent produced no output)" : null,
            error: outcome.ok ? null : outcome.error,
          };
          await saveDelegation(finished);
        },
      }
    );
    if (pid != null) {
      record.pid = pid;
      await saveDelegation(record);
    }
    return json({ ok: true, delegationId: id });
  }

  const delegationCancelMatch = url.pathname.match(/^\/api\/delegations\/([^/]+)\/cancel$/);
  if (delegationCancelMatch && req.method === "POST") {
    const d = await loadDelegation(delegationCancelMatch[1]);
    if (!d) return json({ error: "delegation not found" }, { status: 404 });
    if (d.status === "running" && d.pid != null) {
      try {
        process.kill(d.pid);
      } catch {
        // already gone
      }
      await saveDelegation({ ...d, status: "error", error: "cancelled by user", finishedAt: Date.now() });
    }
    return json({ ok: true });
  }

  if (url.pathname === "/api/delegations" && req.method === "GET") {
    return json({ delegations: await loadAllDelegations() });
  }

  const delegationApiMatch = url.pathname.match(/^\/api\/delegations\/([^/]+)$/);
  if (delegationApiMatch && req.method === "GET") {
    const d = await loadDelegation(delegationApiMatch[1]);
    if (!d) return json({ error: "delegation not found" }, { status: 404 });
    return json({ delegation: d });
  }
  if (delegationApiMatch && req.method === "DELETE") {
    await deleteDelegation(delegationApiMatch[1]);
    return json({ ok: true });
  }

  const delegationPageMatch = url.pathname.match(/^\/delegations\/([^/]+)$/);
  if (delegationPageMatch && req.method === "GET") {
    const d = await loadDelegation(delegationPageMatch[1]);
    if (!d) return new Response("Delegation not found", { status: 404 });
    const md = d.status === "done" ? d.result || "(no output)" : `## ${d.status}\n\n${d.error || "still running…"}`;
    const body = `# ${d.agentEmoji} ${escapeHtmlServer(d.agentName)} → ${escapeHtmlServer(d.sessionLabel)}\n\n` + md;
    return new Response(markdownToHtml(body, "Delegation result"), { headers: { "Content-Type": "text/html; charset=utf-8" } });
  }

  if (url.pathname === "/delegations" && req.method === "GET") {
    const delegations = await loadAllDelegations();
    return new Response(delegationsIndexHtml(delegations), { headers: { "Content-Type": "text/html; charset=utf-8" } });
  }

  return null;
}
