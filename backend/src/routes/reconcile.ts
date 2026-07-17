// Bridges /clear: the CLI starts a brand-new transcript id for the same running terminal instead
// of resetting the old one in place, so this carries the old id's name/board/etc. over to the new
// id. Exported so it can ALSO be driven by a fast independent background interval (see
// startClearReconciliationPoller below) — relying only on the frontend's ~15s GET /api/sessions
// poll left a real gap: resume a session, /clear it within a couple seconds, and the pre-clear
// pid->sessionId mapping may never get recorded before the id changes, so there's nothing to
// carry over — the new id just shows up as a fresh untitled card instead of "reset to 0%, same
// card." Running this independently every couple seconds shrinks that window drastically.
import { loadRunning, loadMeta, saveMeta, reconcileClearedSessions } from "../store.ts";
import type { Meta } from "../store.ts";
import { scanAllSessions } from "../sessions.ts";
import type { Session } from "../sessions.ts";
import { writeGhosttyTitle, ghosttyWindowTitle } from "../claude/index.ts";

export async function reconcileNow(): Promise<Record<string, Meta>> {
  const [running, meta] = await Promise.all([loadRunning(), loadMeta()]);
  // only scanned lazily, at most once per call, and only if a nameless carry-over actually needs it
  let scannedSessions: Session[] | null = null;
  const resolveFallbackLabel = async (sessionId: string) => {
    if (!scannedSessions) scannedSessions = await scanAllSessions();
    return scannedSessions.find((s) => s.id === sessionId)?.firstMessage?.slice(0, 60) || undefined;
  };
  const { meta: reconciledMeta, changed, reconciled } = await reconcileClearedSessions(running, meta, resolveFallbackLabel);
  if (changed) await saveMeta(reconciledMeta);
  // the terminal window itself didn't restart — it's still reading its ORIGINAL (pre-clear)
  // title file — so keep writing to that same file, just with the carried-over name and the
  // NEW session id's tag, so the still-open window's title (and future resume-focus matching,
  // which now targets the new id) both stay correct across the clear.
  for (const { oldId, newId, carriedName } of reconciled) {
    await writeGhosttyTitle(oldId, ghosttyWindowTitle(carriedName || newId.slice(0, 8), newId));
  }
  return reconciledMeta;
}

let reconcilePollerStarted = false;
export function startClearReconciliationPoller(intervalMs = 1500) {
  if (reconcilePollerStarted) return; // idempotent — tests may import routes more than once
  reconcilePollerStarted = true;
  setInterval(() => {
    reconcileNow().catch(() => {}); // best-effort; a transient failure just waits for the next tick
  }, intervalMs);
}
