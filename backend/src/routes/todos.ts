import { existsSync } from "node:fs";
import { CLAUDE_BIN, KNOWN_MODELS, DANGEROUS_FLAG } from "../constants.ts";
import { loadTodos, saveTodos, loadMeta, saveMeta, sessionLabel } from "../store.ts";
import { scanAllSessions } from "../sessions/index.ts";
import { buildLaunchScript, shellQuote, grids, paneArgv, openTerminalForGrid } from "../claude/index.ts";
import { json } from "./json.ts";

export async function handleTodosRoutes(req: Request, url: URL): Promise<Response | null> {
  if (url.pathname === "/api/todos" && req.method === "GET") {
    const todos = await loadTodos();
    return json({ todos: Object.values(todos) });
  }

  if (url.pathname === "/api/todos" && req.method === "POST") {
    const body = await req.json().catch(() => ({}));
    const title = String(body?.title ?? "").trim();
    if (!title) return json({ error: "title is required" }, { status: 400 });
    const todos = await loadTodos();
    const id = crypto.randomUUID();
    const now = Date.now();
    todos[id] = {
      id,
      title: title.slice(0, 200),
      description: String(body?.description ?? "").trim().slice(0, 4000) || undefined,
      board: String(body?.board ?? "").trim() || undefined,
      status: "todo",
      createdAt: now,
      updatedAt: now,
    };
    await saveTodos(todos);
    return json({ ok: true, todo: todos[id] });
  }

  const todoMatch = url.pathname.match(/^\/api\/todos\/([^/]+)$/);
  if (todoMatch && req.method === "PUT") {
    const id = todoMatch[1];
    const patch = await req.json().catch(() => ({}));
    const todos = await loadTodos();
    if (!todos[id]) return json({ error: "todo not found" }, { status: 404 });
    if (typeof patch.title === "string") todos[id].title = patch.title.slice(0, 200);
    if (typeof patch.description === "string") todos[id].description = patch.description.slice(0, 4000) || undefined;
    if (typeof patch.board === "string") todos[id].board = patch.board || undefined;
    if (typeof patch.status === "string") todos[id].status = patch.status;
    if (typeof patch.assignedSessionId === "string") todos[id].assignedSessionId = patch.assignedSessionId || undefined;
    todos[id].updatedAt = Date.now();
    await saveTodos(todos);
    return json({ ok: true, todo: todos[id] });
  }
  if (todoMatch && req.method === "DELETE") {
    const id = todoMatch[1];
    const todos = await loadTodos();
    delete todos[id];
    await saveTodos(todos);
    return json({ ok: true });
  }

  // Assign a todo to Claude: launch a new session with the todo's description as the prompt
  const todoAssignMatch = url.pathname.match(/^\/api\/todos\/([^/]+)\/assign$/);
  if (todoAssignMatch && req.method === "POST") {
    const id = todoAssignMatch[1];
    const todos = await loadTodos();
    const todo = todos[id];
    if (!todo) return json({ error: "todo not found" }, { status: 404 });
    const body = await req.json().catch(() => ({}));
    const cwd = String(body?.cwd ?? "").trim();
    const model = KNOWN_MODELS.has(body?.model) ? body.model : null;
    const dangerous = body?.dangerous !== false;
    const existingSessionId = String(body?.sessionId ?? "").trim();

    if (existingSessionId) {
      // Resume an existing session with the todo description as a continuation prompt
      const sessions = await scanAllSessions();
      const s = sessions.find((x) => x.id === existingSessionId);
      if (!s) return json({ error: "session not found" }, { status: 404 });
      const task = todo.description || todo.title;
      const cmd = `${shellQuote(CLAUDE_BIN)} --resume ${existingSessionId}${dangerous ? DANGEROUS_FLAG : ""} ${shellQuote(task)}`;
      const meta = await loadMeta();
      const opened = grids.openOrCreate(existingSessionId, paneArgv(cmd), s.cwd, sessionLabel(meta[existingSessionId], s.firstMessage, existingSessionId));
      if (!opened) return json({ error: "failed to start tmux session — is tmux installed?" }, { status: 500 });
      if (process.platform === "darwin" && opened.needsTerminal) openTerminalForGrid(`csm-grid-${opened.gridId}`);
      todo.assignedSessionId = existingSessionId;
      todo.status = "in-progress";
      todo.updatedAt = Date.now();
      await saveTodos(todos);
      return json({ ok: true, sessionId: existingSessionId });
    } else {
      // Launch a new session
      if (!cwd || !existsSync(cwd)) return json({ error: "unknown project directory" }, { status: 400 });
      const task = todo.description || todo.title;
      const sessionId = crypto.randomUUID();
      const script = buildLaunchScript(task, { model, sessionId, dangerous });
      const opened = grids.openOrCreate(sessionId, paneArgv(script), cwd, todo.title);
      if (!opened) return json({ error: "failed to start tmux session — is tmux installed?" }, { status: 500 });
      if (process.platform === "darwin" && opened.needsTerminal) openTerminalForGrid(`csm-grid-${opened.gridId}`);
      const meta = await loadMeta();
      meta[sessionId] = { ...meta[sessionId], name: todo.title };
      await saveMeta(meta);
      todo.assignedSessionId = sessionId;
      todo.status = "in-progress";
      todo.updatedAt = Date.now();
      await saveTodos(todos);
      return json({ ok: true, sessionId });
    }
  }

  return null;
}
