import { KNOWN_MODELS } from "../config.ts";
import { loadAgents, saveAgents } from "../store.ts";
import { json } from "./json.ts";

export async function handleAgentsRoutes(req: Request, url: URL): Promise<Response | null> {
  if (url.pathname === "/api/agents" && req.method === "POST") {
    const body = await req.json().catch(() => ({}));
    const name = String(body?.name ?? "").trim();
    const prompt = String(body?.prompt ?? "").trim();
    if (!name || !prompt) return json({ error: "name and prompt are required" }, { status: 400 });
    const agents = await loadAgents();
    const id = crypto.randomUUID();
    agents[id] = {
      id,
      name: name.slice(0, 60),
      emoji: String(body?.emoji ?? "🤖").trim().slice(0, 4) || "🤖",
      prompt: prompt.slice(0, 4000),
      model: KNOWN_MODELS.has(body?.model) ? body.model : null,
      permission: body?.permission === "edit" ? "edit" : "read-only",
    };
    await saveAgents(agents);
    return json({ ok: true, agent: agents[id] });
  }

  const agentMatch = url.pathname.match(/^\/api\/agents\/([^/]+)$/);
  if (agentMatch && req.method === "PUT") {
    const id = agentMatch[1];
    const agents = await loadAgents();
    if (!agents[id]) return json({ error: "agent not found" }, { status: 404 });
    const body = await req.json().catch(() => ({}));
    const a = agents[id];
    if (typeof body.name === "string" && body.name.trim()) a.name = body.name.trim().slice(0, 60);
    if (typeof body.emoji === "string" && body.emoji.trim()) a.emoji = body.emoji.trim().slice(0, 4);
    if (typeof body.prompt === "string" && body.prompt.trim()) a.prompt = body.prompt.trim().slice(0, 4000);
    if ("model" in body) a.model = KNOWN_MODELS.has(body.model) ? body.model : null;
    if (body.permission === "edit" || body.permission === "read-only") a.permission = body.permission;
    await saveAgents(agents);
    return json({ ok: true, agent: a });
  }
  if (agentMatch && req.method === "DELETE") {
    const id = agentMatch[1];
    const agents = await loadAgents();
    delete agents[id];
    await saveAgents(agents);
    return json({ ok: true });
  }

  return null;
}
