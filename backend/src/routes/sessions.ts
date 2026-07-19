import { readdir, unlink } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { PROJECTS_DIR } from "../constants.ts";
import {
  loadMeta, saveMeta, loadTickets, loadRunning, loadAgents, loadAllDelegations, loadTodos,
  loadBoard, loadTodoBoard, loadGroupBoard, loadProjectBoards, loadSavedViews, loadBoardSettings,
  loadAllQuickPromptJobs, pidAlive,
} from "../store.ts";
import type { Meta } from "../store.ts";
import { scanAllSessions, summarizeSession as summarizeSessionTranscript, computeActivelyWorking } from "../sessions/index.ts";
import {
  ghosttyWindowTitle, writeGhosttyTitle, deleteGhosttyTitle, ghosttyTitleFilePath,
  openTerminalRunning, tryFocusRunningSession, closeRunningSessionTerminal, ghosttyWindowTag, shellQuote, usingGhostty,
} from "../claude/index.ts";
import { CLAUDE_BIN, DANGEROUS_FLAG } from "../constants.ts";
import { json } from "./json.ts";
import { reconcileNow } from "./reconcile.ts";

export async function handleSessionsRoutes(req: Request, url: URL): Promise<Response | null> {
  if (url.pathname === "/api/sessions" && req.method === "GET") {
    const [sessions, running, reconciledMeta, tickets, agents, delegations, quickPrompts, todos, board, todoBoard, groupBoard, projectBoards, savedViews, boardSettings] = await Promise.all([
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
      loadGroupBoard(),
      loadProjectBoards(),
      loadSavedViews(),
      loadBoardSettings(),
    ]);
    // see computeActivelyWorking (sessions/index.ts) — shared with fsWatcher.ts's SSE push so both
    // compute this identically.
    const enriched = sessions.map((s) => {
      const r = running[s.id] ?? null;
      return {
        ...s,
        running: r,
        activelyWorking: computeActivelyWorking(s, r),
        meta: reconciledMeta[s.id] ?? {},
      };
    });
    return json({
      sessions: enriched, tickets: Object.values(tickets), agents: Object.values(agents), delegations, quickPrompts,
      todos: Object.values(todos), board, todoBoard, groupBoard, projectBoards, savedViews, boardSettings,
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

    // fork never has an existing window to reuse. Otherwise focus is keyed by the csm-<id8> tag,
    // not loadRunning()'s pid — see terminalFocus.ts.
    if (!fork) {
      const pid = usingGhostty() ? null : (await loadRunning())[id]?.pid ?? null;
      if (await tryFocusRunningSession(pid, ghosttyWindowTag(id))) {
        return json({ ok: true, focused: true, cwd: s.cwd });
      }
      // About to launch a new terminal — refuse if a headless Quick Prompt is still running on
      // this session, to avoid two processes on one transcript.
      const bgQuickPrompt = (await loadAllQuickPromptJobs()).find(
        (j) => j.sessionId === id && j.status === "running" && j.pid != null && pidAlive(j.pid),
      );
      if (bgQuickPrompt) {
        return json({
          ok: false,
          busy: true,
          error: "A quick prompt is running in the background on this session — opening a terminal now would start a second process on the same conversation. Wait for it to finish (watch the chip on the card), then resume.",
        }, { status: 409 });
      }
    }

    const cmd = `${shellQuote(CLAUDE_BIN)} --resume ${id}${fork ? " --fork-session" : ""}${dangerous ? DANGEROUS_FLAG : ""}`;
    // same display label the card itself uses, so the Ghostty window title reads like the UI —
    // written to a file *before* launch so the window's title-polling loop has it from frame one
    const meta = await loadMeta();
    const label = meta[id]?.name || s.firstMessage || id.slice(0, 8);
    if (!fork) await writeGhosttyTitle(id, ghosttyWindowTitle(label, id));
    await openTerminalRunning(s.cwd, cmd, fork ? {} : { ghosttyTitleFile: ghosttyTitleFilePath(id), ghosttyTag: ghosttyWindowTag(id) });
    return json({ ok: true, command: cmd, cwd: s.cwd });
  }

  const closeTerminalMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/close-terminal$/);
  if (closeTerminalMatch && req.method === "POST") {
    const id = closeTerminalMatch[1];
    // Unlike the resume route, a missing/stale pid here just means we skip the direct kill and
    // fall back to whatever the window-close action alone accomplishes — never a false veto.
    const pid = (await loadRunning())[id]?.pid ?? null;
    const closed = await closeRunningSessionTerminal(pid, ghosttyWindowTag(id));
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
    await deleteGhosttyTitle(id);
    return json({ ok: deleted });
  }

  return null;
}
