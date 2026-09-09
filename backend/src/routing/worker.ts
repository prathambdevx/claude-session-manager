// Background digest maintenance. Keeps routing digests warm so the router itself never has to read
// a transcript — the expensive work (parsing and summarizing hundreds of MB) happens BEFORE you
// ask, spread over time, which is what makes routing a single fast call.
//
// Deliberately a trickle, not a sweep. A startup backfill across this machine's recent sessions
// would fire hundreds of Haiku calls in one burst (the largest single session needs ~35 chunks on
// its own) — a surprising amount of quota to spend without being asked. Instead: one job at a
// time, a gap between jobs, and digests converge in the background. Routing works from the first
// request regardless, because the router always has each session's raw tail and file list even
// when its digest is empty; coverage just improves over the first few minutes.
import { join } from "node:path";
import { PROJECTS_DIR } from "../constants.ts";
import { catchUpDigest, hasPendingChunk, IDLE_SETTLE_MS, CorruptDigestError } from "./digest.ts";
import { startPool, stopPool, HAIKU } from "../claude/warmPool.ts";
import { isRouterEnabled } from "./config.ts";

/** gap between summarization jobs — keeps this a trickle rather than a burst of `claude` processes */
const JOB_GAP_MS = 1_500;
/** Sessions summarized concurrently — kept at 4 despite measured 0.8x per-session throughput
 *  (CPU-bound `claude` boot contention) because breadth across live sessions matters more than any
 *  one session's latency; see docs/master-session-router.md for the full measurement. */
const CONCURRENCY = 4;
/**
 * Warm Haiku slots. Deliberately NOT larger than CONCURRENCY: spare slots measured slower, not
 * faster, because simultaneous boots contend (4 slots -> 30.6s/chunk vs 16.7s cold sequential).
 */
const HAIKU_POOL_SLOTS = CONCURRENCY;
/** queue ceiling; beyond this the oldest pending entries are dropped (they'll be re-queued on the
 *  session's next write, or by the next /api/route call) */
const MAX_QUEUE = 200;
/** chunks summarized per session per turn through the queue */
const WORKER_CHUNKS_PER_PASS = 3;

type Job = { sessionId: string; projectSlug: string };

const queued = new Map<string, Job>(); // sessionId -> job, dedupes a burst of writes into one
const settleTimers = new Map<string, ReturnType<typeof setTimeout>>();
let active = 0; // in-flight jobs, capped at CONCURRENCY
let stopped = false;

function enqueue(sessionId: string, projectSlug: string): void {
  if (stopped || !isRouterEnabled()) return;
  if (!queued.has(sessionId) && queued.size >= MAX_QUEUE) {
    const oldest = queued.keys().next().value;
    if (oldest) queued.delete(oldest);
  }
  queued.set(sessionId, { sessionId, projectSlug });
  void drain();
}

export function queueDigestCatchUp(sessionId: string, projectSlug: string): void {
  if (stopped || !isRouterEnabled()) return;
  enqueue(sessionId, projectSlug);

  // Trailing re-enqueue — without this, catchUpDigest's settled-span path was unreachable in
  // normal operation. The only routine trigger is fsWatcher firing ON A WRITE, at which point the
  // transcript's mtime is now, so `settled` is false and an under-full trailing span is skipped;
  // the re-check that would happen once idle only ever arrived via /api/route, and then only for
  // the survivors of gatherCandidates. Net effect measured: 21 transcripts written in 24h, 5
  // digests on disk. This fires once the session has actually gone quiet, and deliberately does
  // NOT re-arm itself, so a settled session doesn't wake the worker forever.
  const existing = settleTimers.get(sessionId);
  if (existing) clearTimeout(existing);
  settleTimers.set(
    sessionId,
    setTimeout(() => {
      settleTimers.delete(sessionId);
      enqueue(sessionId, projectSlug);
    }, IDLE_SETTLE_MS + 5_000)
  );
}

async function runJob(job: Job): Promise<void> {
  const path = join(PROJECTS_DIR, job.projectSlug, `${job.sessionId}.jsonl`);
  try {
    if (!(await hasPendingChunk(job.sessionId, path))) return; // cheap stat, the common case
    // small cap per pass: a session with 30 pending chunks must not block every other session's
    // turn in the queue. It re-queues itself on its next write, or via /api/route.
    await catchUpDigest(job.sessionId, path, WORKER_CHUNKS_PER_PASS);
  } catch (e) {
    // A corrupt digest file is skipped, never "recovered" by discarding it — see CorruptDigestError
    // in digest.ts. Any other failure leaves coveredBytes untouched, so the span is retried.
    if (e instanceof CorruptDigestError) console.warn(`[routing] ${e.message} — skipping`);
  }
}

// Never spins up the warm pool for a job that turns out to have no pending chunk — a trivial write
// (one tool_result, under the 12,000-byte gate) used to boot 4 processes and tear them down again
// moments later, since startPool ran before any job was checked.
async function drain(): Promise<void> {
  if (stopped || !isRouterEnabled()) return;

  while (!stopped && isRouterEnabled() && queued.size && active < CONCURRENCY) {
    const [id, job] = queued.entries().next().value as [string, Job];
    queued.delete(id);

    const path = join(PROJECTS_DIR, job.projectSlug, `${job.sessionId}.jsonl`);
    let pending: boolean;
    try {
      pending = await hasPendingChunk(job.sessionId, path);
    } catch {
      pending = false;
    }
    if (!pending) continue; // cheap stat only — the pool is never touched for this session

    startPool(HAIKU, HAIKU_POOL_SLOTS);
    active++;
    // deliberately not awaited: this is what lets CONCURRENCY jobs overlap instead of queueing
    void runJob(job).finally(async () => {
      active--;
      if (queued.size) {
        await Bun.sleep(JOB_GAP_MS);
        void drain();
      } else if (active === 0) {
        // nothing left to summarize — let the pool go rather than holding processes open
        stopPool(HAIKU);
      }
    });
  }
}

export function digestQueueDepth(): number {
  return queued.size;
}

// Drops queued work and kills the warm pool immediately when the router is toggled off — without
// this, disabling only blocked NEW enqueues while already-queued/in-flight jobs kept running to
// completion. Does not set `stopped`: unlike stopDigestWorker(), this is meant to be resumable by
// isRouterEnabled() flipping back to true.
export function flushDigestQueue(): void {
  queued.clear();
  for (const t of settleTimers.values()) clearTimeout(t);
  settleTimers.clear();
  stopPool(HAIKU);
}

/** test hook — prevents a queued job from outliving the test that enqueued it */
export function stopDigestWorker(): void {
  stopped = true;
  queued.clear();
  stopPool(HAIKU);
  for (const t of settleTimers.values()) clearTimeout(t);
  settleTimers.clear();
}
