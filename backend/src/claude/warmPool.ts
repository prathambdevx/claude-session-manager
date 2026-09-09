// Pre-spawned, idle `claude` processes kept ready so a call doesn't pay CLI startup.
//
// Why this exists: measured on this machine, a one-shot `claude -p` pays ~7.5s of fixed startup
// (process spawn, config/plugin/MCP init) before the prompt is even considered — a trivial "Reply
// with exactly: OK" costs the same 7.4-7.8s as a real routing prompt. That was ~60% of a 12.3s
// routing decision, and ~8 of the ~17s spent per digest chunk. Switching model doesn't help (Haiku
// measured no faster); cutting prompt size can only touch the smaller half.
//
// Three measured facts shape the design:
//   - Reuse works: within one process, prompt 1 took 6.3s, prompts 2 and 3 took 1.6s and 1.9s.
//   - Startup is EAGER: a process spawned and left idle 10s answered its first prompt in 2.5s.
//   - Context ACCUMULATES across prompts in one process (prompt 2 could recall prompt 1). So a
//     process serves EXACTLY ONE real prompt and is then discarded — otherwise earlier work would
//     bias later calls and input tokens would grow without bound.
//   - An idle process survives: still ready and answering in 2.2s / 3.5s after 60s and 120s idle.
//     No keep-alive pings are needed; it simply blocks on a stdin read.
//
// Pools are per-model because `--model` is fixed at spawn. Slot count matters for throughput: with
// one slot a sequential workload becomes BOOT-limited (~7.5s/call) rather than call-limited, so a
// batch workload wants 2+ slots to overlap the next boot with the current call.
//
// No API key, no billing change — the same CLI the rest of the app already shells out to.
import { CLAUDE_BIN, HOME } from "../constants.ts";

type Slot = {
  proc: ReturnType<typeof Bun.spawn>;
  ask: (prompt: string, timeoutMs: number) => Promise<string>;
  spawnedAt: number;
  used: boolean;
  /** resolves once the process has provably finished booting (the priming ping came back) */
  ready: Promise<void>;
  isReady: boolean;
};

type Pool = { model: string; size: number; slots: Slot[]; idleTimer: ReturnType<typeof setTimeout> | null };

/** a slot older than this is stale (auth/session state may have moved on) — recycled unused */
const MAX_SLOT_AGE_MS = 20 * 60 * 1000;
/** release a pool after this much inactivity — an idle process measures ~157 MB RSS */
const IDLE_RELEASE_MS = 10 * 60 * 1000;

export const SONNET = "sonnet";
export const HAIKU = "claude-haiku-4-5-20251001";

const pools = new Map<string, Pool>();

function spawnSlot(model: string): Slot {
  const proc = Bun.spawn(
    [CLAUDE_BIN, "-p", "--input-format", "stream-json", "--output-format", "stream-json",
     "--model", model, "--verbose", "--no-session-persistence", "--tools", ""],
    { cwd: HOME, stdin: "pipe", stdout: "pipe", stderr: "pipe" }
  );

  const reader = proc.stdout.getReader();
  const dec = new TextDecoder();
  let buf = "";

  const ask = async (prompt: string, timeoutMs: number): Promise<string> => {
    proc.stdin.write(JSON.stringify({ type: "user", message: { role: "user", content: prompt } }) + "\n");
    await proc.stdin.flush();
    const deadline = Date.now() + timeoutMs;
    while (true) {
      if (Date.now() > deadline) throw new Error("warm claude timed out");
      const { value, done } = await reader.read();
      if (done) throw new Error("warm claude closed its stream");
      buf += dec.decode(value, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        let ev: any;
        try {
          ev = JSON.parse(line);
        } catch {
          continue; // non-JSON noise on the stream
        }
        if (ev.type === "result") {
          if (ev.is_error) throw new Error(String(ev.result ?? ev.subtype ?? "warm claude error"));
          return String(ev.result ?? "").trim();
        }
      }
    }
  };

  const slot: Slot = { proc, ask, spawnedAt: Date.now(), used: false, ready: Promise.resolve(), isReady: false };

  // Readiness must be PROVEN, not timed. The startup stream emits only hook events — there is no
  // "init"/"ready" event to await — and treating "the object exists" as ready handed out processes
  // still mid-boot, producing cold timings (6.9s, 8.1s) from a pool that was supposed to be warm.
  // The priming ping's ~20 tokens are irrelevant: the process serves one real prompt and is binned.
  slot.ready = slot
    .ask("Reply with exactly: READY", 60_000)
    .then(() => {
      slot.isReady = true;
    })
    .catch(() => {
      // a slot that can't answer a ping is useless; isReady stays false so askPool skips it
    });

  return slot;
}

function discard(slot: Slot | undefined): void {
  if (!slot) return;
  try {
    slot.proc.stdin.end();
  } catch {
    // already closed
  }
  try {
    slot.proc.kill();
  } catch {
    // already dead
  }
}

function prune(pool: Pool): void {
  pool.slots = pool.slots.filter((s) => {
    const stale = s.used || Date.now() - s.spawnedAt > MAX_SLOT_AGE_MS;
    if (stale) discard(s);
    return !stale;
  });
}

/** Bring a pool up to `size` warm slots and (re)start its idle release timer. Idempotent. */
export function startPool(model: string, size = 1): void {
  let pool = pools.get(model);
  if (!pool) {
    pool = { model, size, slots: [], idleTimer: null };
    pools.set(model, pool);
  }
  pool.size = Math.max(pool.size, size);
  prune(pool);
  while (pool.slots.length < pool.size) pool.slots.push(spawnSlot(model));

  if (pool.idleTimer) clearTimeout(pool.idleTimer);
  pool.idleTimer = setTimeout(() => stopPool(model), IDLE_RELEASE_MS);
}

export function stopPool(model: string): void {
  const pool = pools.get(model);
  if (!pool) return;
  if (pool.idleTimer) clearTimeout(pool.idleTimer);
  for (const s of pool.slots) discard(s);
  pools.delete(model);
}

export function poolReady(model: string): boolean {
  return (pools.get(model)?.slots ?? []).some((s) => !s.used && s.isReady);
}

export function poolStatus(model: string): { enabled: boolean; ready: boolean; slots: number; readySlots: number } {
  const pool = pools.get(model);
  const slots = pool?.slots ?? [];
  return {
    enabled: !!pool,
    ready: slots.some((s) => !s.used && s.isReady),
    slots: slots.length,
    readySlots: slots.filter((s) => !s.used && s.isReady).length,
  };
}

/**
 * Run one prompt on a warm slot of `model`. Throws if the pool is absent or every slot fails —
 * callers fall back to runClaudeHeadless, which is always correct, just slower.
 */
export async function askPool(model: string, prompt: string, timeoutMs = 60_000): Promise<string> {
  const pool = pools.get(model);
  if (!pool) throw new Error(`no warm pool for ${model}`);

  // Only take an ALREADY-PROVEN slot. An earlier version awaited a still-booting one, reasoning
  // that waiting out a boot beat paying for a new one — measurably false under load: the caller
  // then serialized behind the slowest boot, and a batch ran ~2x slower than plain cold spawns.
  // Throwing lets the caller fall back to a cold spawn immediately, which is the faster option
  // whenever no slot is genuinely ready.
  const slot = pool.slots.find((s) => !s.used && s.isReady);
  if (!slot) throw new Error("no ready warm slot");

  slot.used = true;
  try {
    return await slot.ask(prompt, timeoutMs);
  } finally {
    // Used exactly once, always: context accumulates, so reuse would leak the previous prompt into
    // the next. Replace immediately so the following call finds a warm slot instead of a boot.
    discard(slot);
    pool.slots = pool.slots.filter((s) => s !== slot);
    if (pools.has(model)) {
      while (pool.slots.length < pool.size) pool.slots.push(spawnSlot(model));
    }
  }
}

// ---- Sonnet convenience wrappers (the routing decision path) ----
export const startWarmPool = (model: string = SONNET) => startPool(model, 1);
export const stopWarmPool = () => stopPool(SONNET);
export const warmPoolReady = () => poolReady(SONNET);
export const warmPoolStatus = () => poolStatus(SONNET);
export const askWarm = (prompt: string, timeoutMs = 60_000) => askPool(SONNET, prompt, timeoutMs);
