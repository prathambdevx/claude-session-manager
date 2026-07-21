// Quick Prompt: hands a session a follow-up task without ever opening or focusing a terminal.
// A live pane (attached or not) gets the prompt via tmux send-keys; a not-running session gets a
// fresh detached tmux session started on the prompt as claude's initial argument — see
// handleQuickPromptRoutes and spec docs/spec/2026-07-21-tmux-terminal-architecture.md §7.5.
import { CLAUDE_BIN, DANGEROUS_FLAG } from "../constants.ts";
import { saveQuickPromptJob, loadQuickPromptJob, deleteQuickPromptJob, loadMeta, sessionLabel } from "../store.ts";
import type { QuickPromptJob } from "../store.ts";
import { scanAllSessions } from "../sessions/index.ts";
import { grids, paneArgv, shellQuote, sendKeys } from "../claude/index.ts";
import { json } from "./json.ts";

export async function handleQuickPromptRoutes(req: Request, url: URL): Promise<Response | null> {
  if (url.pathname === "/api/quickprompts" && req.method === "POST") {
    const body = await req.json().catch(() => ({}));
    const sessionId = String(body?.sessionId ?? "");
    const promptRaw = String(body?.prompt ?? "").trim();
    if (!promptRaw) return json({ error: "prompt is required" }, { status: 400 });
    const dangerous = body?.dangerous !== false;
    const sessions = await scanAllSessions();
    const s = sessions.find((x) => x.id === sessionId);
    if (!s) return json({ error: "session not found" }, { status: 404 });

    // a literal newline sent via send-keys -l is an Enter to the pty underneath it, which would
    // submit the prompt early — collapse to spaces so it always arrives as one line
    const prompt = promptRaw.replace(/\r?\n/g, " ").slice(0, 4000);
    const id = crypto.randomUUID();
    const baseRecord: QuickPromptJob = {
      id, sessionId, cwd: s.cwd, prompt,
      status: "running", createdAt: Date.now(), finishedAt: null,
      result: null, error: null, pid: null, progress: [],
    };

    if (process.platform === "darwin") grids.reconcile();
    const pane = grids.resolvePane(sessionId);
    const delivered = pane ? sendKeys(pane.paneId, prompt) : false;
    if (!delivered && !pane) {
      const cmd = `${shellQuote(CLAUDE_BIN)} --resume ${sessionId}${dangerous ? DANGEROUS_FLAG : ""} ${shellQuote(prompt)}`;
      const meta = await loadMeta();
      // always its own detached grid — must never spill a pane into the user's currently visible window
      const opened = grids.openStandalone(sessionId, paneArgv(cmd), s.cwd, sessionLabel(meta[sessionId], s.firstMessage, sessionId));
      if (!opened) return json({ error: "failed to start tmux session — is tmux installed?" }, { status: 500 });
    } else if (!delivered) {
      const finished: QuickPromptJob = { ...baseRecord, status: "error", finishedAt: Date.now(), error: "failed to deliver to the terminal" };
      await saveQuickPromptJob(finished);
      return json({ error: "failed to deliver to the terminal" }, { status: 500 });
    }

    // there's no "wait until done" anymore — the prompt either landed in a live pane the user can
    // watch, or started a fresh attachable session; the board's own working/done chips (driven by
    // the transcript scan) take over from here
    const finished: QuickPromptJob = {
      ...baseRecord, status: "done", finishedAt: Date.now(),
      result: "Sent — check the terminal for the response.",
    };
    await saveQuickPromptJob(finished);
    return json({ ok: true, jobId: id });
  }

  const cancelMatch = url.pathname.match(/^\/api\/quickprompts\/([^/]+)\/cancel$/);
  if (cancelMatch && req.method === "POST") {
    const j = await loadQuickPromptJob(cancelMatch[1]);
    if (!j) return json({ error: "job not found" }, { status: 404 });
    if (j.status === "running") {
      await saveQuickPromptJob({ ...j, status: "error", error: "cancelled by user", finishedAt: Date.now() });
    }
    return json({ ok: true });
  }

  const apiMatch = url.pathname.match(/^\/api\/quickprompts\/([^/]+)$/);
  if (apiMatch && req.method === "DELETE") {
    await deleteQuickPromptJob(apiMatch[1]);
    return json({ ok: true });
  }

  return null;
}
