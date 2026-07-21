import { readdir, unlink } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { PROJECTS_DIR, CLAUDE_BIN, DANGEROUS_FLAG } from "../constants.ts";
import {
  loadMeta, saveMeta, loadTickets, loadRunning, loadAgents, loadAllDelegations, loadTodos,
  loadTodoBoard, loadGroupBoard, loadSavedViews,
  loadAllQuickPromptJobs, pidAlive, sessionLabel,
} from "../store.ts";
import type { Meta } from "../store.ts";
import { scanAllSessions, summarizeSession as summarizeSessionTranscript, computeActivelyWorking } from "../sessions/index.ts";
import { grids, paneArgv, shellQuote, openTerminalForGrid, focusGridWindow, isTmuxAvailable } from "../claude/index.ts";
import { json } from "./json.ts";
import { reconcileNow } from "../polling/reconcile.ts";

// Waits for a forked pane's real session id to show up in ~/.claude/sessions/*.json, keyed by pid
// — `exec` in the pane's argv means the tmux pane's own pid IS the claude process's pid throughout
// its life, so a fresh RunningInfo entry with that pid is exactly the forked session appearing.
async function discoverForkSid(pid: number, timeoutMs = 8000): Promise<string | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const running = await loadRunning();
    const hit = Object.entries(running).find(([, info]) => info.pid === pid);
    if (hit) return hit[0];
    await Bun.sleep(300);
  }
  return null;
}

export async function handleSessionsRoutes(req: Request, url: URL): Promise<Response | null> {
  if (url.pathname === "/api/sessions" && req.method === "GET") {
    const [sessions, running, reconciledMeta, tickets, agents, delegations, quickPrompts, todos, todoBoard, groupBoard, savedViews] = await Promise.all([
      scanAllSessions(),
      loadRunning(),
      reconcileNow(),
      loadTickets(),
      loadAgents(),
      loadAllDelegations(),
      loadAllQuickPromptJobs(),
      loadTodos(),
      loadTodoBoard(),
      loadGroupBoard(),
      loadSavedViews(),
    ]);
    if (process.platform === "darwin") grids.reconcile();
    // see computeActivelyWorking (sessions/index.ts) — shared with fsWatcher.ts's SSE push so both
    // compute this identically. `attached` is strictly "a tmux client has this session's grid open" —
    // it can be false even while `running` is set (process alive, window closed) — see spec §10.1.
    const enriched = sessions.map((s) => {
      const r = running[s.id] ?? null;
      return {
        ...s,
        running: r,
        attached: grids.isAttached(s.id),
        activelyWorking: computeActivelyWorking(s, r),
        meta: reconciledMeta[s.id] ?? {},
      };
    });
    return json({
      sessions: enriched, tickets: Object.values(tickets), agents: Object.values(agents), delegations, quickPrompts,
      todos: Object.values(todos), todoBoard, groupBoard, savedViews,
      tmuxAvailable: process.platform !== "darwin" || isTmuxAvailable(),
    });
  }

  const metaMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/meta$/);
  if (metaMatch && req.method === "PUT") {
    const id = metaMatch[1];
    const patch = (await req.json()) as Meta;
    const meta = await loadMeta();
    // a plain spread would replace the WHOLE boardTags map, clobbering every other board's own
    // entry — each board/view's tag lives at its own key, so this merges key-by-key instead
    const hasBoardTagsPatch = patch.boardTags && typeof patch.boardTags === "object";
    const boardTags = hasBoardTagsPatch ? { ...meta[id]?.boardTags, ...patch.boardTags } : meta[id]?.boardTags;
    meta[id] = { ...meta[id], ...patch, ...(boardTags ? { boardTags } : {}) };
    await saveMeta(meta);
    if (typeof patch.name === "string" && patch.name.trim() && process.platform === "darwin") {
      grids.setName(id, patch.name.trim());
    }
    return json({ ok: true, meta: meta[id] });
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
      const description = await summarizeSessionTranscript(s);
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
    const meta = await loadMeta();
    const label = sessionLabel(meta[id], s.firstMessage, id);

    // fork always starts a new pane — there's never an existing pane to reuse for it — but that pane
    // can still auto-tile into an already-open grid, so needsTerminal still gates the terminal open.
    if (fork) {
      const cmd = `${shellQuote(CLAUDE_BIN)} --resume ${id} --fork-session${dangerous ? DANGEROUS_FLAG : ""}`;
      const opened = grids.openForkPending(paneArgv(cmd), s.cwd, label);
      if (!opened) return json({ error: "failed to start tmux session — is tmux installed?" }, { status: 500 });
      if (process.platform === "darwin" && opened.needsTerminal) openTerminalForGrid(`csm-grid-${opened.gridId}`);
      const pid = grids.getPanePid(opened.paneId);
      if (pid != null) {
        discoverForkSid(pid).then((discovered) => {
          if (discovered) grids.resolveForkSid(opened.paneId, discovered);
        });
      }
      return json({ ok: true, cwd: s.cwd });
    }

    const resumed = grids.resolveForResume(id);
    if (resumed) {
      grids.focus(id);
      if (process.platform === "darwin") {
        if (resumed.attached) focusGridWindow(resumed.session);
        else openTerminalForGrid(resumed.session);
      }
      return json({ ok: true, focused: true, cwd: s.cwd });
    }

    // About to launch a new terminal — refuse if a headless Quick Prompt is still running on this
    // session, to avoid two processes on one transcript.
    const bgQuickPrompt = (await loadAllQuickPromptJobs()).find(
      (j) => j.sessionId === id && j.status === "running" && j.pid != null && pidAlive(j.pid),
    );
    if (bgQuickPrompt) {
      return json({
        ok: false,
        busy: true,
        error: "This is a quick prompt running in a closed session — wait for it to finish, then resume.",
      }, { status: 409 });
    }

    const cmd = `${shellQuote(CLAUDE_BIN)} --resume ${id}${dangerous ? DANGEROUS_FLAG : ""}`;
    const opened = grids.openOrCreate(id, paneArgv(cmd), s.cwd, label);
    if (!opened) return json({ error: "failed to start tmux session — is tmux installed?" }, { status: 500 });
    if (process.platform === "darwin" && opened.needsTerminal) openTerminalForGrid(`csm-grid-${opened.gridId}`);
    return json({ ok: true, command: cmd, cwd: s.cwd });
  }

  const closeTerminalMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/close-terminal$/);
  if (closeTerminalMatch && req.method === "POST") {
    const id = closeTerminalMatch[1];
    const closed = process.platform === "darwin" ? grids.closeSession(id) : false;
    return json({ ok: true, closed });
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

  return null;
}
