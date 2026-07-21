// Bridges /clear (new transcript id, same terminal): carries the old id's name/board over to the
// new one. Also run on its own fast interval (not just the browser's poll) — a /clear within a
// couple seconds of resume could otherwise slip past before the mapping is recorded.
import { loadRunning, loadMeta, saveMeta, reconcileClearedSessions } from "../store.ts";
import type { Meta } from "../store.ts";
import { scanAllSessions } from "../sessions/index.ts";
import type { Session } from "../sessions/index.ts";
import { grids } from "../claude/index.ts";

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
  // the pane running this session is still tagged with the pre-clear sid — retag it so
  // quick-prompt/close/focus keep resolving to the right pane after a /clear
  if (reconciled.length && process.platform === "darwin") {
    grids.reconcile(); // rebuild sidToPane from live tmux first — a pane created <3s ago isn't in memory yet, else the retag is silently dropped for good
    for (const { oldId, newId } of reconciled) grids.remapSid(oldId, newId);
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
