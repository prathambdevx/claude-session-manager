// Quick Prompt: hands a session a follow-up task without opening a terminal. Types into an open
// terminal if one exists, else runs headless in the background — see handleQuickPromptRoutes.
import { stat, readFile } from "node:fs/promises";
import { join } from "node:path";
import { PROJECTS_DIR, QUICKPROMPT_TERMINAL_WATCH_TIMEOUT_MS } from "../constants.ts";
import { saveQuickPromptJob, loadQuickPromptJob, deleteQuickPromptJob, loadRunning } from "../store.ts";
import type { QuickPromptJob } from "../store.ts";
import { scanAllSessions } from "../sessions/index.ts";
import { runClaudeHeadlessDetached, sendPromptToRunningTerminal, ghosttyWindowTag, usingGhostty } from "../claude/index.ts";
import { activityLine } from "../claude/activity.ts";
import { json } from "./json.ts";

const WATCH_POLL_MS = 1000;

function lastAssistantEntry(raw: string): any | null {
  const lines = raw.split("\n").filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const d = JSON.parse(lines[i]);
      if (d?.type === "assistant") return d;
    } catch {
      continue;
    }
  }
  return null;
}

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

// Polls the transcript for a genuinely final response (plain-text last block, activityLine's 💭)
// rather than the first change — otherwise a multi-step task flipped "done" after just the first
// tool call. baselineEntryUuid must belong to a DIFFERENT assistant entry than whatever was already
// last in the transcript before this prompt was sent — a bare mtime change can otherwise be the
// previous turn's write still settling to disk, which reads back as an instant false "done".
function watchTranscriptForCompletion(
  record: QuickPromptJob, transcriptPath: string, sinceMtimeMs: number,
  baselineEntryUuid: string | null, startedAt: number = Date.now()
) {
  const tick = async () => {
    if (Date.now() - startedAt > QUICKPROMPT_TERMINAL_WATCH_TIMEOUT_MS) {
      await saveQuickPromptJob({
        ...record, status: "error", finishedAt: Date.now(),
        error: "No final response seen in the terminal within the wait window — it may still be working; check there directly.",
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
        // fall through with empty text — treated as "still working", not a false "done"
      }
      const entry = lastAssistantEntry(text);
      const isNewEntry = entry && entry.uuid !== baselineEntryUuid;
      const line = isNewEntry ? activityLine(entry) : null;
      // Claude Code's own busy/idle status tracked true in testing (flips the instant real work
      // finishes) — require it to also agree before trusting the transcript-only signal.
      const running = await loadRunning();
      const stillBusy = running[record.sessionId]?.status === "busy";
      if (line?.startsWith("💭") && !stillBusy) {
        await saveQuickPromptJob({
          ...record, status: "done", finishedAt: Date.now(),
          result: lastAssistantText(text) || "(sent — check the terminal for its response)",
        });
        return;
      }
      record.progress = [...record.progress, line || "Working…"];
      await saveQuickPromptJob(record);
      setTimeout(() => watchTranscriptForCompletion(record, transcriptPath, mtimeMs, baselineEntryUuid, startedAt), WATCH_POLL_MS);
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

    // Prefer typing the prompt straight into this session's OWN already-open terminal (no new
    // window ever opened) over a background run. For Ghostty the authoritative "is it open?" signal
    // is whether a window carrying this session's csm tag exists — checked inside
    // sendPromptToRunningTerminal — so we attempt it regardless of loadRunning() (whose status
    // files were unreliably missing live terminals). For Terminal.app we still need a live pid (it
    // targets by tty), so that stays gated on loadRunning. If no terminal is open, it falls through
    // to the headless background run below.
    const running = await loadRunning();
    const live = running[sessionId];
    if (usingGhostty() || live) {
      let baselineMtimeMs = 0;
      let baselineEntryUuid: string | null = null;
      try {
        baselineMtimeMs = (await stat(transcriptPath)).mtimeMs;
        baselineEntryUuid = lastAssistantEntry(await readFile(transcriptPath, "utf-8"))?.uuid ?? null;
      } catch {
        // no transcript on disk yet — any future write counts as new
      }
      const delivered = await sendPromptToRunningTerminal(live?.pid ?? null, ghosttyWindowTag(sessionId), prompt);
      if (delivered) {
        const record: QuickPromptJob = { ...baseRecord, progress: ["Sent — waiting for a response in the terminal…"] };
        await saveQuickPromptJob(record); // persist "running" immediately so the chip shows up right away
        watchTranscriptForCompletion(record, transcriptPath, baselineMtimeMs, baselineEntryUuid);
        return json({ ok: true, deliveredTo: "terminal", jobId: id });
      }
      // no open terminal for this session (or delivery failed) — fall through to the background
      // path below instead of dead-ending with nothing visible
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
