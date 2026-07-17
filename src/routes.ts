// HTTP request routing: maps every API + page path to the store/session/claude helpers.
import { readdir, unlink } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { PROJECTS_DIR, REVIEWS_DIR, PUBLIC_DIR, KNOWN_MODELS, LAUNCH_MODES, EFFORT_FLAG, DANGEROUS_FLAG, CLAUDE_BIN } from "./config.ts";
import {
  loadMeta, saveMeta, loadTickets, saveTickets, loadRunning, reconcileClearedSessions,
  saveReview, loadReview, saveContext, loadContext,
  loadAgents, saveAgents, saveDelegation, loadDelegation, loadAllDelegations, deleteDelegation,
  loadTodos, saveTodos,
  loadBoard, saveBoard, loadTodoBoard, saveTodoBoard, loadProjectBoards, saveProjectBoards,
} from "./store.ts";
import type { Meta, Ticket, ReviewRecord, ContextRecord, Agent, Delegation, Todo } from "./store.ts";
import {
  scanAllSessions, keywordSearchScores, queryNeedles, matchSnippets,
  projectNameFromCwd, buildTranscriptDigest, summarizeSession,
} from "./sessions.ts";
import type { Session } from "./sessions.ts";
import {
  runClaudeHeadless, runClaudeHeadlessDetached, buildDelegationPrompt,
  openTerminalRunning, tryFocusRunningSession, ghosttyWindowTag, ghosttyWindowTitle, modelAliasWithContext, shellQuote,
  buildLaunchScript, buildFileReviewPrompt, buildFixPrompt, buildContextExtractionPrompt, buildContinuationPrompt,
} from "./claude.ts";
import { escapeHtmlServer, reviewsIndexHtml, markdownToHtml, delegationsIndexHtml } from "./html.ts";

function json(data: unknown, init?: ResponseInit) {
  return new Response(JSON.stringify(data), {
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
  });
}

export async function handleRequest(req: Request): Promise<Response> {
  const url = new URL(req.url);

  if (url.pathname === "/api/sessions" && req.method === "GET") {
    const [sessions, running, meta, tickets, agents, delegations, todos, board, todoBoard, projectBoards] = await Promise.all([
      scanAllSessions(),
      loadRunning(),
      loadMeta(),
      loadTickets(),
      loadAgents(),
      loadAllDelegations(),
      loadTodos(),
      loadBoard(),
      loadTodoBoard(),
      loadProjectBoards(),
    ]);
    // bridge /clear: the CLI starts a brand-new transcript id for the same running terminal
    // instead of resetting the old one in place, so carry the old id's name/board/etc. over.
    const { meta: reconciledMeta, changed } = await reconcileClearedSessions(running, meta);
    if (changed) await saveMeta(reconciledMeta);
    const enriched = sessions.map((s) => ({
      ...s,
      running: running[s.id] ?? null,
      meta: reconciledMeta[s.id] ?? {},
    }));
    return json({ sessions: enriched, tickets: Object.values(tickets), agents: Object.values(agents), delegations, todos: Object.values(todos), board, todoBoard, projectBoards });
  }

  // ---------- board columns (server-side, shared across browsers) ----------

  if (url.pathname === "/api/board" && req.method === "PUT") {
    const body = await req.json().catch(() => ({}));
    const cols = Array.isArray(body?.columns) ? body.columns : null;
    if (!cols) return json({ error: "columns array required" }, { status: 400 });
    const clean = cols
      .filter((c: any) => c && typeof c.id === "string" && typeof c.title === "string")
      .map((c: any) => ({ id: c.id.slice(0, 60), title: c.title.slice(0, 80), ...(c.cwd ? { cwd: String(c.cwd).slice(0, 500) } : {}) }));
    await saveBoard(clean);
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

  // per-project board columns — each project (keyed by its raw cwd) gets its own
  // independent column set, fully separate from the shared main board above.
  if (url.pathname === "/api/project-board" && req.method === "PUT") {
    const body = await req.json().catch(() => ({}));
    const cwd = String(body?.cwd ?? "").trim().slice(0, 500);
    if (!cwd) return json({ error: "cwd required" }, { status: 400 });
    const cols = Array.isArray(body?.columns) ? body.columns : null;
    if (!cols) return json({ error: "columns array required" }, { status: 400 });
    const clean = cols
      .filter((c: any) => c && typeof c.id === "string" && typeof c.title === "string")
      .map((c: any) => ({ id: c.id.slice(0, 60), title: c.title.slice(0, 80) }));
    const all = await loadProjectBoards();
    all[cwd] = clean;
    await saveProjectBoards(all);
    return json({ ok: true, columns: clean });
  }

  // ---------- agents CRUD ----------

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

  // ---------- delegations (background agent jobs) ----------

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
    if (typeof patch.board === "string") allowed.board = patch.board || undefined;
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

  const metaMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/meta$/);
  if (metaMatch && req.method === "PUT") {
    const id = metaMatch[1];
    const patch = (await req.json()) as Meta;
    const meta = await loadMeta();
    meta[id] = { ...meta[id], ...patch };
    await saveMeta(meta);
    return json({ ok: true, meta: meta[id] });
  }

  if (url.pathname === "/api/projects" && req.method === "GET") {
    const sessions = await scanAllSessions();
    const cwds = [...new Set(sessions.map((s) => s.cwd))].sort();
    return json({ projects: cwds });
  }

  if (url.pathname === "/api/search" && req.method === "GET") {
    const raw = (url.searchParams.get("q") || "").trim().toLowerCase();
    if (raw.length < 2) return json({ ids: [] });
    const scores = await keywordSearchScores(raw, 0.65);
    const ids = Object.keys(scores).sort((a, b) => scores[b] - scores[a]).slice(0, 20);
    return json({ ids });
  }

  if (url.pathname === "/api/search/smart" && req.method === "POST") {
    const body = await req.json().catch(() => ({}));
    const q = String(body?.q ?? "").trim();
    if (q.length < 2) return json({ ids: [] });
    const days = Number(body?.days) || 0; // 0 = all time
    const cutoff = days > 0 ? Date.now() - days * 86400000 : 0;

    const sessions = await scanAllSessions();
    const meta = await loadMeta();
    const needles = queryNeedles(q.toLowerCase(), true);

    // cast a wide net for recall (low bar), then let Claude pick the true best matches from that pool
    const scores = await keywordSearchScores(q.toLowerCase(), 0.25);
    const poolIds = Object.keys(scores)
      .filter((id) => {
        if (!cutoff) return true;
        const s = sessions.find((x) => x.id === id);
        return s ? s.lastActive >= cutoff : false;
      })
      .sort((a, b) => scores[b] - scores[a])
      .slice(0, 60);
    if (!poolIds.length) return json({ ids: [] });

    // re-rank the pool by co-occurrence density (best single-message snippet), not raw
    // term-count-anywhere — the session that actually DID the thing has the query terms clustered
    // in one message; sessions that merely mention a keyword have them scattered
    const ranked = (
      await Promise.all(
        poolIds.map(async (id) => {
          const s = sessions.find((x) => x.id === id);
          if (!s) return null;
          const { snippets, density } = await matchSnippets(join(PROJECTS_DIR, s.projectSlug, `${id}.jsonl`), needles);
          return { s, snippets, density };
        })
      )
    )
      .filter((r): r is { s: Session; snippets: string[]; density: number } => !!r)
      .sort((a, b) => b.density - a.density)
      .slice(0, 15);

    if (!ranked.length) return json({ ids: [] });
    const candidates = ranked.map((r) => r.s);

    const listing = ranked
      .map(({ s, snippets }, i) => {
        const m = meta[s.id] || {};
        const label = m.name || m.description || s.firstMessage || "(untitled)";
        const evidence = snippets.length ? snippets.join(" … ") : s.userMessageSample.slice(0, 2).join(" / ");
        return `${i + 1}. ${label.slice(0, 100)} — project: ${projectNameFromCwd(s.cwd)}\n   matches: ${evidence.slice(0, 700)}`;
      })
      .join("\n");

    const prompt =
      `A user is trying to find a past coding session matching this description:\n"${q}"\n\n` +
      `Here are candidate sessions, each with snippets from where the query terms actually appear in that session:\n${listing}\n\n` +
      "Pick the sessions that genuinely match the FULL description (not ones that just happen to mention a keyword). " +
      "Reply with ONLY the numbers, best match first, at most 3, comma-separated (e.g. \"4, 12\"). " +
      "If none genuinely match, reply with exactly NONE. No other text.";

    try {
      const result = await runClaudeHeadless(prompt, { tools: "", model: "sonnet", timeoutMs: 45000 });
      const numbers = [...new Set((result.match(/\d+/g) || []).map((n) => parseInt(n, 10)))].slice(0, 3);
      const ids = numbers.map((n) => candidates[n - 1]?.id).filter((id): id is string => !!id);
      return json({ ids });
    } catch (e: any) {
      return json({ error: e?.message ?? "smart search failed" }, { status: 500 });
    }
  }

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
    await openTerminalRunning(cwd, script);
    if (name) {
      const meta = await loadMeta();
      meta[sessionId] = { ...meta[sessionId], name };
      await saveMeta(meta);
    }
    return json({ ok: true, cwd, mode, sessionId });
  }

  const reviewMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/review$/);
  if (reviewMatch && req.method === "POST") {
    const id = reviewMatch[1];
    const body = await req.json().catch(() => ({}));
    const model = KNOWN_MODELS.has(body?.model) ? body.model : null;
    const focus = String(body?.focus ?? "").trim().slice(0, 300) || undefined;
    const sessions = await scanAllSessions();
    const s = sessions.find((x) => x.id === id);
    if (!s) return json({ error: "session not found" }, { status: 404 });
    if (!s.changedFiles.length) return json({ error: "no changed files found for this session" }, { status: 422 });
    const prompt = buildFileReviewPrompt(s.changedFiles, focus);
    try {
      // read-only: the reviewer can inspect files but never edit them here — fixing is a separate, supervised step
      const markdown = await runClaudeHeadless(prompt, {
        cwd: s.cwd,
        model: model || "sonnet",
        disallowedTools: "Edit,Write,NotebookEdit",
        timeoutMs: 240000,
      });
      const reviewId = crypto.randomUUID();
      const review: ReviewRecord = { id: reviewId, sessionId: id, cwd: s.cwd, files: s.changedFiles, model, createdAt: Date.now(), markdown };
      await saveReview(review);
      const meta = await loadMeta();
      meta[id] = { ...meta[id], lastReviewId: reviewId };
      await saveMeta(meta);
      return json({ ok: true, reviewId, fileCount: s.changedFiles.length });
    } catch (e: any) {
      return json({ error: e?.message ?? "review failed" }, { status: 500 });
    }
  }

  const reviewGetMatch = url.pathname.match(/^\/api\/reviews\/([^/]+)$/);
  if (reviewGetMatch && req.method === "GET") {
    const review = await loadReview(reviewGetMatch[1]);
    if (!review) return json({ error: "review not found" }, { status: 404 });
    return json({ review });
  }

  if (url.pathname === "/reviews" && req.method === "GET") {
    let files: string[] = [];
    try {
      files = (await readdir(REVIEWS_DIR)).filter((f) => f.endsWith(".json"));
    } catch {
      // no reviews dir yet
    }
    const reviews = (await Promise.all(files.map((f) => loadReview(f.replace(/\.json$/, "")))))
      .filter((r): r is ReviewRecord => !!r)
      .sort((a, b) => b.createdAt - a.createdAt);
    const meta = await loadMeta();
    const rows = reviews
      .map((r) => {
        const label = meta[r.sessionId]?.name || meta[r.sessionId]?.description || r.sessionId;
        const firstLine = (r.markdown.split("\n").find((l) => l.trim() && !l.startsWith("#")) || "").slice(0, 160);
        return (
          `<a class="card" href="/reviews/${r.id}">` +
          `<div class="t">${escapeHtmlServer(label)}</div>` +
          `<div class="m">${projectNameFromCwd(r.cwd)} · ${r.files.length} file${r.files.length === 1 ? "" : "s"}${r.model ? " · " + r.model : ""}</div>` +
          `<div class="s">${escapeHtmlServer(firstLine)}</div></a>`
        );
      })
      .join("");
    const body =
      `<h1>Reviews (${reviews.length})</h1>` +
      (reviews.length ? `<div class="list">${rows}</div>` : `<p class="empty">No reviews yet.</p>`);
    return new Response(reviewsIndexHtml(body), { headers: { "Content-Type": "text/html; charset=utf-8" } });
  }

  const reviewPageMatch = url.pathname.match(/^\/reviews\/([^/]+)$/);
  if (reviewPageMatch && req.method === "GET") {
    const review = await loadReview(reviewPageMatch[1]);
    if (!review) return new Response("Review not found", { status: 404 });
    return new Response(markdownToHtml(review.markdown), { headers: { "Content-Type": "text/html; charset=utf-8" } });
  }

  const fixMatch = url.pathname.match(/^\/api\/reviews\/([^/]+)\/fix$/);
  if (fixMatch && req.method === "POST") {
    const review = await loadReview(fixMatch[1]);
    if (!review) return json({ error: "review not found" }, { status: 404 });
    const body = await req.json().catch(() => ({}));
    const writeTests = Boolean(body?.writeTests);
    let selection: "all" | number[] = "all";
    if (body?.selection !== "all") {
      const nums = String(body?.selection ?? "")
        .split(/[,\s]+/)
        .map((n: string) => parseInt(n, 10))
        .filter((n: number) => Number.isFinite(n) && n > 0);
      if (!nums.length) return json({ error: "no valid finding numbers given" }, { status: 400 });
      selection = nums;
    }
    const dangerous = body?.dangerous !== false;
    const prompt = buildFixPrompt(review, selection, writeTests);
    const modelFlag = review.model ? ` --model ${modelAliasWithContext(review.model)}` : "";
    const cmd = `${shellQuote(CLAUDE_BIN)}${modelFlag}${EFFORT_FLAG}${dangerous ? DANGEROUS_FLAG : ""} ${shellQuote(prompt)}`;
    await openTerminalRunning(review.cwd, cmd);
    return json({ ok: true, cwd: review.cwd, selection });
  }

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

  const summarizeMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/summarize$/);
  if (summarizeMatch && req.method === "POST") {
    const id = summarizeMatch[1];
    const sessions = await scanAllSessions();
    const s = sessions.find((x) => x.id === id);
    if (!s) return json({ error: "session not found" }, { status: 404 });
    if (!s.userMessageSample.length) {
      return json({ error: "no user messages to summarize" }, { status: 422 });
    }
    try {
      const description = await summarizeSession(s);
      const meta = await loadMeta();
      meta[id] = { ...meta[id], description, descriptionSource: "auto" };
      await saveMeta(meta);
      return json({ ok: true, description });
    } catch (e: any) {
      return json({ error: e?.message ?? "summarize failed" }, { status: 500 });
    }
  }

  const resumeMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/resume$/);
  if (resumeMatch && req.method === "POST") {
    const id = resumeMatch[1];
    const body = await req.json().catch(() => ({}));
    const fork = Boolean(body?.fork);
    const dangerous = body?.dangerous !== false; // dangerous-by-default, matching fresh launches
    const sessions = await scanAllSessions();
    const s = sessions.find((x) => x.id === id);
    if (!s) return json({ error: "session not found" }, { status: 404 });

    // fork always creates a new session, so there's never an existing window to reuse for it
    if (!fork) {
      const running = await loadRunning();
      const info = running[id];
      if (info && (await tryFocusRunningSession(info.pid, ghosttyWindowTag(id)))) {
        return json({ ok: true, focused: true, cwd: s.cwd });
      }
    }

    const cmd = `${shellQuote(CLAUDE_BIN)} --resume ${id}${fork ? " --fork-session" : ""}${dangerous ? DANGEROUS_FLAG : ""}`;
    // same display label the card itself uses, so the Ghostty window title reads like the UI
    const meta = await loadMeta();
    const label = meta[id]?.name || s.firstMessage || id.slice(0, 8);
    await openTerminalRunning(s.cwd, cmd, fork ? {} : { ghosttyTitle: ghosttyWindowTitle(label, id) });
    return json({ ok: true, command: cmd, cwd: s.cwd });
  }

  const deleteMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)$/);
  if (deleteMatch && req.method === "DELETE") {
    const id = deleteMatch[1];
    const projectDirs = await readdir(PROJECTS_DIR);
    let deleted = false;
    for (const slug of projectDirs) {
      const path = join(PROJECTS_DIR, slug, `${id}.jsonl`);
      if (existsSync(path)) {
        await unlink(path);
        deleted = true;
        break;
      }
    }
    const meta = await loadMeta();
    delete meta[id];
    await saveMeta(meta);
    return json({ ok: deleted });
  }

  // ---------- todos CRUD ----------

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
      await openTerminalRunning(s.cwd, cmd);
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
      const script = buildLaunchScript(task, "solo", { model, sessionId, dangerous });
      await openTerminalRunning(cwd, script);
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

  // client-routed pages (SPA): "/", "/projects", and "/projects/<encoded-cwd>" all serve the
  // same index.html so the board-mode/per-project drill-in views survive a hard reload/deep link.
  if (req.method === "GET" && /^\/(projects(\/.*)?)?$/.test(url.pathname)) {
    return new Response(Bun.file(join(PUBLIC_DIR, "index.html")));
  }

  // static files
  const file = Bun.file(join(PUBLIC_DIR, url.pathname));
  if (await file.exists()) return new Response(file);

  return new Response("Not found", { status: 404 });
}
