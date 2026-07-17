import { loadTickets, saveTickets } from "../store.ts";
import type { Ticket } from "../store.ts";
import { json } from "./json.ts";

export async function handleTicketsRoutes(req: Request, url: URL): Promise<Response | null> {
  if (url.pathname === "/api/tickets" && req.method === "POST") {
    const body = await req.json().catch(() => ({}));
    const title = String(body?.title ?? "").trim();
    if (!title) return json({ error: "title is required" }, { status: 400 });
    const tickets = await loadTickets();
    const id = crypto.randomUUID();
    tickets[id] = {
      id,
      title: title.slice(0, 200),
      notes: String(body?.notes ?? "").trim().slice(0, 2000) || undefined,
      cwd: String(body?.cwd ?? "").trim() || undefined,
      board: String(body?.board ?? "").trim() || undefined,
      createdAt: Date.now(),
    };
    await saveTickets(tickets);
    return json({ ok: true, ticket: tickets[id] });
  }

  const ticketMatch = url.pathname.match(/^\/api\/tickets\/([^/]+)$/);
  if (ticketMatch && req.method === "PUT") {
    const id = ticketMatch[1];
    const patch = await req.json().catch(() => ({}));
    const tickets = await loadTickets();
    if (!tickets[id]) return json({ error: "ticket not found" }, { status: 404 });
    const allowed: Partial<Ticket> = {};
    if (typeof patch.title === "string") allowed.title = patch.title.slice(0, 200);
    if (typeof patch.notes === "string") allowed.notes = patch.notes.slice(0, 2000) || undefined;
    // `null` (not `undefined` — JSON.stringify drops undefined keys entirely) is how a client
    // clears a ticket's board tag or project, e.g. dropping it back onto "All sessions"
    if (typeof patch.board === "string" || patch.board === null) allowed.board = patch.board || undefined;
    if (typeof patch.cwd === "string" || patch.cwd === null) allowed.cwd = patch.cwd || undefined;
    if (typeof patch.done === "boolean") allowed.done = patch.done;
    if (typeof patch.startedSessionId === "string") allowed.startedSessionId = patch.startedSessionId || undefined;
    tickets[id] = { ...tickets[id], ...allowed };
    await saveTickets(tickets);
    return json({ ok: true, ticket: tickets[id] });
  }
  if (ticketMatch && req.method === "DELETE") {
    const id = ticketMatch[1];
    const tickets = await loadTickets();
    delete tickets[id];
    await saveTickets(tickets);
    return json({ ok: true });
  }

  return null;
}
