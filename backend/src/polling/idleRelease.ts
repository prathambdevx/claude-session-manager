// After 30 minutes with no user request, drop the per-transcript head cache and force a GC; the next
// list request re-reads the heads (small, bounded reads). Fires once per idle period.
import { releaseSessionCaches } from "../sessions/index.ts";

export const IDLE_RELEASE_MS = 30 * 60 * 1000;
const CHECK_INTERVAL_MS = 60 * 1000;

let lastUserRequest = Date.now();
let released = false;

// The SSE stream stays open, and the board polls GET /api/sessions every 15s while a tab is open,
// so neither counts as a user request; page loads (static files) and every other API call do.
export function noteRequest(req: Request, url: URL): void {
  if (url.pathname === "/api/events") return;
  if (req.method === "GET" && url.pathname === "/api/sessions") return;
  lastUserRequest = Date.now();
  released = false;
}

export function releaseIfIdle(now = Date.now(), idleMs = IDLE_RELEASE_MS): boolean {
  if (released || now - lastUserRequest < idleMs) return false;
  releaseSessionCaches();
  released = true;
  Bun.gc(true);
  return true;
}

let started = false;
export function startIdleRelease(): void {
  if (started) return;
  started = true;
  setInterval(() => releaseIfIdle(), CHECK_INTERVAL_MS).unref?.();
}
