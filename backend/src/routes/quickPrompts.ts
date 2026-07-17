// "Quick Prompt" — hands the SAME session a follow-up task without opening a terminal yourself.
// Two delivery paths, tried in order — BOTH get a persisted job + progress chip, so the outcome is
// always visible somewhere, never a silent dead end:
//
// 1. Terminal already open for this session: deliver the prompt straight into that existing
//    window (focus it, type the whole prompt as one burst, press Return) via
//    sendPromptToRunningTerminal — exactly as if the user had typed it there themselves. There's no
//    subprocess to await here (it's a real interactive terminal now), so progress is inferred by
//    polling that session's own transcript file for a new response to show up (watchTranscriptFor
//    Completion) rather than fabricating a percentage.
// 2. Terminal not open, OR (1) couldn't actually deliver it (focus/keystroke failed — e.g. this
//    machine hasn't granted System Events Accessibility permission yet): resume that session's own
//    transcript non-interactively in the background (`claude --resume <id> -p "<prompt>"`, see
//    runClaudeHeadlessDetached's resumeSessionId) — same continuity as clicking "Resume" and
//    typing, just without a terminal window. Real subprocess, real streamed progress, mirroring
//    routes/delegations.ts's pattern.
import { stat, readFile } from "node:fs/promises";
import { join } from "node:path";
import { PROJECTS_DIR, QUICKPROMPT_TERMINAL_WATCH_TIMEOUT_MS } from "../config.ts";
import { saveQuickPromptJob, loadQuickPromptJob, deleteQuickPromptJob, loadRunning } from "../store.ts";
import type { QuickPromptJob } from "../store.ts";
import { scanAllSessions } from "../sessions.ts";
import { runClaudeHeadlessDetached, sendPromptToRunningTerminal, ghosttyWindowTag } from "../claude/index.ts";
import { json } from "./json.ts";

const WATCH_POLL_MS = 3000;

function lastAssistantText(raw: string): string | null {
  const lines = raw.split("\n").filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    let d: any;
    try {
      d = JSON.parse(lines[i]);
    } catch {
      continue;
    }
    if (d?.type === "assistant" && Array.isArray(d?.message?.content)) {
      for (const block of d.message.content) {
        if (block?.type === "text" && block.text?.trim()) return block.text.trim();
      }
    }
  }
  return null;
}

// Polls the session's own transcript file for a new entry appended after `sinceMtimeMs` (the
// moment we just typed the prompt in) — the only way to observe progress once the prompt has gone
// into a real interactive terminal instead of a subprocess we control. Fire-and-forget; writes its
// own conclusion to the job record when it detects a change or times out.
function watchTranscriptForCompletion(record: QuickPromptJob, transcriptPath: string, sinceMtimeMs: number) {
  const startedAt = Date.now();
  const tick = async () => {
    if (Date.now() - startedAt > QUICKPROMPT_TERMINAL_WATCH_TIMEOUT_MS) {
      await saveQuickPromptJob({
        ...record, status: "error", finishedAt: Date.now(),
        error: "No response seen in the terminal within the wait window — it may still be working; check there directly.",
      });
      return;
    }
    let mtimeMs = 0;
    try {
      mtimeMs = (await stat(transcriptPath)).mtimeMs;
    } catch {
      // not written yet — keep waiting
    }
    if (mtimeMs > sinceMtimeMs) {
      await new Promise((r) => setTimeout(r, 500)); // let the writer finish flushing this turn
      let text = "";
      try {
        text = await readFile(transcriptPath, "utf-8");
      } catch {
        // fall through with empty text — still counts as "something changed"
      }
      const msg = lastAssistantText(text);
      await saveQuickPromptJob({
        ...record, status: "done", finishedAt: Date.now(),
        result: msg || "(sent — check the terminal for its response)",
      });
      return;
    }
    setTimeout(tick, WATCH_POLL_MS);
  };
  setTimeout(tick, WATCH_POLL_MS);
}

export async function handleQuickPromptRoutes(req: Request, url: URL): Promise<Response | null> {
  if (url.pathname === "/api/quickprompts" && req.method === "POST") {
    const body = await req.json().catch(() => ({}));
    const sessionId = String(body?.sessionId ?? "");
    const prompt = String(body?.prompt ?? "").trim();
    if (!prompt) return json({ error: "prompt is required" }, { status: 400 });
    const sessions = await scanAllSessions();
    const s = sessions.find((x) => x.id === sessionId);
    if (!s) return json({ error: "session not found" }, { status: 404 });

    const transcriptPath = join(PROJECTS_DIR, s.projectSlug, `${sessionId}.jsonl`);
    const id = crypto.randomUUID();
    const baseRecord: QuickPromptJob = {
      id,
      sessionId,
      cwd: s.cwd,
      prompt: prompt.slice(0, 4000),
      status: "running",
      createdAt: Date.now(),
      finishedAt: null,
      result: null,
      error: null,
      pid: null,
      progress: [],
    };

    const running = await loadRunning();
    const live = running[sessionId];
    if (live) {
      let baselineMtimeMs = 0;
      try {
        baselineMtimeMs = (await stat(transcriptPath)).mtimeMs;
      } catch {
        // no transcript on disk yet — any future write counts as new
      }
      const delivered = await sendPromptToRunningTerminal(live.pid, ghosttyWindowTag(sessionId), prompt);
      if (delivered) {
        const record: QuickPromptJob = { ...baseRecord, progress: ["Sent — waiting for a response in the terminal…"] };
        await saveQuickPromptJob(record); // persist "running" immediately so the chip shows up right away
        watchTranscriptForCompletion(record, transcriptPath, baselineMtimeMs);
        return json({ ok: true, deliveredTo: "terminal", jobId: id });
      }
      // couldn't reach the open terminal (focus or keystroke failed) — fall through to the
      // background path below instead of dead-ending with nothing visible
    }

    await saveQuickPromptJob(baseRecord); // persist "running" before spawning, so it's visible immediately

    const pid = runClaudeHeadlessDetached(
      baseRecord.prompt,
      { cwd: s.cwd, permission: "edit", resumeSessionId: sessionId },
      {
        onProgress: (activity) => {
          baseRecord.progress = activity;
          saveQuickPromptJob(baseRecord); // live feed; fire-and-forget write (throttled by the runner)
        },
        onClose: async (outcome) => {
          const finished: QuickPromptJob = {
            ...baseRecord,
            status: outcome.ok ? "done" : "error",
            finishedAt: Date.now(),
            result: outcome.ok ? outcome.output || "(no output)" : null,
            error: outcome.ok ? null : outcome.error,
          };
          await saveQuickPromptJob(finished);
        },
      }
    );
    if (pid != null) {
      baseRecord.pid = pid;
      await saveQuickPromptJob(baseRecord);
    }
    return json({ ok: true, jobId: id });
  }

  const cancelMatch = url.pathname.match(/^\/api\/quickprompts\/([^/]+)\/cancel$/);
  if (cancelMatch && req.method === "POST") {
    const j = await loadQuickPromptJob(cancelMatch[1]);
    if (!j) return json({ error: "job not found" }, { status: 404 });
    if (j.status === "running") {
      if (j.pid != null) {
        try {
          process.kill(j.pid);
        } catch {
          // already gone
        }
      }
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
