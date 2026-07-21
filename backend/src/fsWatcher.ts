// Watches Claude Code's own status/transcript files plus this app's Quick Prompt job files, and
// pushes a granular per-entity update over SSE — the browser patches just that one session/job,
// not a full re-fetch.
//
// Debounces per-entity: a burst of raw fs events from one write collapses into a single push, and
// one session's burst never delays another's.
import { watch, existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { RUNNING_DIR, PROJECTS_DIR, QUICKPROMPTS_DIR } from "./constants.ts";
import { loadRunning, loadMeta, loadQuickPromptJob } from "./store.ts";
import type { RunningInfo } from "./store.ts";
import { scanTranscript, computeActivelyWorking } from "./sessions/index.ts";
import { broadcast } from "./sse.ts";
import { grids } from "./claude/index.ts";

const DEBOUNCE_MS = 100;
const timers = new Map<string, ReturnType<typeof setTimeout>>();

function debounced(key: string, fn: () => void | Promise<void>) {
  const existing = timers.get(key);
  if (existing) clearTimeout(existing);
  timers.set(
    key,
    setTimeout(() => {
      timers.delete(key);
      fn();
    }, DEBOUNCE_MS)
  );
}

// A running-status file's name is just its pid (<pid>.json) — the session id it belongs to is
// only found INSIDE the file. When that file gets deleted (the terminal closed / process exited),
// the delete event still only gives us the pid back, with nothing left to read — so remember the
// mapping the moment we last successfully read it, purely to resolve deletions.
const pidToSessionId = new Map<number, string>();

async function refreshSessionFromTranscript(sessionId: string, projectSlug: string) {
  const path = join(PROJECTS_DIR, projectSlug, `${sessionId}.jsonl`);
  let session;
  try {
    session = await scanTranscript(path, sessionId, projectSlug);
  } catch {
    // file's gone — this transcript was deleted (DELETE /api/sessions/:id unlinks it), not just changed
    broadcast({ type: "session-removed", id: sessionId });
    return;
  }
  // Same unresumable-stub filter as scanAllSessions() — this is the one other path that can push a
  // session into the browser's live state, so it needs the identical check or a broken transcript's
  // very first write slips through here before the next full /api/sessions fetch would catch it.
  if (session.messageCount === 0 || !existsSync(session.cwd)) {
    broadcast({ type: "session-removed", id: sessionId });
    return;
  }
  const [running, meta] = await Promise.all([loadRunning(), loadMeta()]);
  const r = running[sessionId] ?? null;
  // `attached` must ride along — this push replaces the session wholesale, so omitting it flickers the dot grey on every transcript write
  broadcast({
    type: "session",
    session: {
      ...session,
      running: r,
      attached: process.platform === "darwin" ? grids.isAttached(sessionId) : false,
      activelyWorking: computeActivelyWorking(session, r),
      meta: meta[sessionId] ?? {},
    },
  });
}

async function handleRunningFileChange(filename: string) {
  const m = filename.match(/^(\d+)\.json$/);
  if (!m) return;
  const pid = Number(m[1]);
  let running: RunningInfo | null = null;
  let sessionId: string | undefined;
  try {
    running = JSON.parse(await readFile(join(RUNNING_DIR, filename), "utf-8"));
    sessionId = (running as any)?.sessionId;
    if (sessionId) pidToSessionId.set(pid, sessionId);
  } catch {
    sessionId = pidToSessionId.get(pid); // file's gone — fall back to what we last knew for this pid
    pidToSessionId.delete(pid);
  }
  if (!sessionId) return;
  const resolvedSessionId = sessionId;
  debounced(`running:${resolvedSessionId}`, () => {
    // A pure status flip (busy/idle/waiting, or the process exiting) doesn't change any
    // transcript-derived field, so a lightweight patch is enough — no transcript re-scan needed.
    // The frontend recomputes activelyWorking itself from this plus the lastActive it already has.
    broadcast({ type: "session-patch", id: resolvedSessionId, patch: { running } });
  });
}

async function handleProjectsChange(filename: string) {
  const m = filename.match(/^([^/]+)\/([^/]+)\.jsonl$/);
  if (!m) return;
  const [, projectSlug, sessionId] = m;
  debounced(`transcript:${sessionId}`, () => refreshSessionFromTranscript(sessionId, projectSlug));
}

async function handleQuickPromptChange(filename: string) {
  const m = filename.match(/^([^/]+)\.json$/);
  if (!m) return;
  const jobId = m[1];
  debounced(`quickprompt:${jobId}`, async () => {
    const job = await loadQuickPromptJob(jobId);
    broadcast(job ? { type: "quickprompt", job } : { type: "quickprompt-removed", id: jobId });
  });
}

let started = false;
export function startFsWatcher(): void {
  if (started) return; // idempotent — tests may import routes more than once
  started = true;

  // recursive:true is FSEvents-backed on macOS — cheap regardless of how many files/subdirectories
  // exist underneath, unlike a poll that has to stat() every one of them on a timer. This app only
  // ships for macOS + Ghostty/Terminal, so no Linux inotify-recursive fallback is needed here.
  const watchers = [
    watch(RUNNING_DIR, { recursive: true }, (_event, filename) => {
      if (filename) handleRunningFileChange(filename);
    }),
    watch(PROJECTS_DIR, { recursive: true }, (_event, filename) => {
      if (filename) handleProjectsChange(filename);
    }),
    watch(QUICKPROMPTS_DIR, { recursive: true }, (_event, filename) => {
      if (filename) handleQuickPromptChange(filename);
    }),
  ];

  // fs.watch on a directory that gets deleted/recreated out from under it can throw asynchronously
  // rather than just stop — swallow that rather than crashing the whole server over a watcher.
  for (const w of watchers) {
    w.on("error", () => {});
  }
}
