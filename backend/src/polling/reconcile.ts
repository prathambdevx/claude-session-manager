// Bridges /clear (new transcript id, same terminal): carries the old id's name/board over to the
// new one. Also run on its own fast interval (not just the browser's poll) — a /clear within a
// couple seconds of resume could otherwise slip past before the mapping is recorded.
import { loadRunning, loadMeta, saveMeta, reconcileClearedSessions } from "../store.ts";
import type { Meta } from "../store.ts";
import { scanAllSessions } from "../sessions/index.ts";
import type { Session } from "../sessions/index.ts";
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
  // The window is still reading its pre-clear title file, so keep writing there — with the
  // carried-over name and the new session's tag — to keep both its title and future focus-matching
  // correct.
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
