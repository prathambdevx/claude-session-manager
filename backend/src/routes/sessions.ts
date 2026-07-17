import { readdir, unlink } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { PROJECTS_DIR } from "../config.ts";
import {
  loadMeta, saveMeta, loadTickets, loadRunning, loadAgents, loadAllDelegations, loadTodos,
  loadBoard, loadTodoBoard, loadProjectBoards, loadSavedViews, loadBoardSettings,
  loadAllQuickPromptJobs,
} from "../store.ts";
import type { Meta } from "../store.ts";
import { scanAllSessions, summarizeSession as summarizeSessionTranscript } from "../sessions.ts";
import {
  ghosttyWindowTitle, writeGhosttyTitle, deleteGhosttyTitle, ghosttyTitleFilePath,
  openTerminalRunning, tryFocusRunningSession, ghosttyWindowTag, shellQuote,
} from "../claude/index.ts";
import { CLAUDE_BIN, DANGEROUS_FLAG } from "../config.ts";
import { json } from "./json.ts";
import { reconcileNow } from "./reconcile.ts";

export async function handleSessionsRoutes(req: Request, url: URL): Promise<Response | null> {
  if (url.pathname === "/api/sessions" && req.method === "GET") {
    const [sessions, running, reconciledMeta, tickets, agents, delegations, quickPrompts, todos, board, todoBoard, projectBoards, savedViews, boardSettings] = await Promise.all([
      scanAllSessions(),
      loadRunning(),
      reconcileNow(),
      loadTickets(),
      loadAgents(),
      loadAllDelegations(),
      loadAllQuickPromptJobs(),
      loadTodos(),
      loadBoard(),
      loadTodoBoard(),
      loadProjectBoards(),
      loadSavedViews(),
      loadBoardSettings(),
    ]);
    // Claude Code's own status file (running.status) isn't reliable for this: a long-running
    // interactive terminal can get stuck reporting a stale "waiting" (e.g. from an old permission
    // prompt) for the rest of its life even while real work keeps happening — confirmed live, a
    // session sat at status:"waiting"/updatedAt from an hour prior while its transcript kept
    // getting fresh tool-use writes every few seconds. Quick Prompt's own terminal-delivery path
    // already sidesteps this the same way (routes/quickPrompts.ts's watchTranscriptForCompletion):
    // trust the transcript's own mtime, not the CLI's self-reported flag. `busy` still counts too,
    // since a background/headless job (Delegations, Quick Prompt's non-terminal path) has no
    // transcript writes of its own to watch until it's done.
    const ACTIVITY_WINDOW_MS = 15_000;
    const enriched = sessions.map((s) => {
      const r = running[s.id] ?? null;
      return {
        ...s,
        running: r,
        activelyWorking: r?.status === "busy" || Date.now() - s.lastActive < ACTIVITY_WINDOW_MS,
        meta: reconciledMeta[s.id] ?? {},
      };
    });
    return json({
      sessions: enriched, tickets: Object.values(tickets), agents: Object.values(agents), delegations, quickPrompts,
      todos: Object.values(todos), board, todoBoard, projectBoards, savedViews, boardSettings,
    });
  }

  const metaMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/meta$/);
  if (metaMatch && req.method === "PUT") {
    const id = metaMatch[1];
    const patch = (await req.json()) as Meta;
    const meta = await loadMeta();
    meta[id] = { ...meta[id], ...patch };
    await saveMeta(meta);
    // keep an already-open Ghostty window's title in sync with a rename (harmless no-op if the
    // session isn't currently open — its window-title-polling loop just isn't there to read it)
    if (typeof patch.name === "string" && patch.name.trim()) {
      await writeGhosttyTitle(id, ghosttyWindowTitle(patch.name.trim(), id));
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

    // fork always creates a new session, so there's never an existing window to reuse for it
    if (!fork) {
      const running = await loadRunning();
      const info = running[id];
      if (info && (await tryFocusRunningSession(info.pid, ghosttyWindowTag(id)))) {
        return json({ ok: true, focused: true, cwd: s.cwd });
      }
    }

    const cmd = `${shellQuote(CLAUDE_BIN)} --resume ${id}${fork ? " --fork-session" : ""}${dangerous ? DANGEROUS_FLAG : ""}`;
    // same display label the card itself uses, so the Ghostty window title reads like the UI —
    // written to a file *before* launch so the window's title-polling loop has it from frame one
    const meta = await loadMeta();
    const label = meta[id]?.name || s.firstMessage || id.slice(0, 8);
    if (!fork) await writeGhosttyTitle(id, ghosttyWindowTitle(label, id));
    await openTerminalRunning(s.cwd, cmd, fork ? {} : { ghosttyTitleFile: ghosttyTitleFilePath(id) });
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
    await deleteGhosttyTitle(id);
    return json({ ok: deleted });
  }

  return null;
}
