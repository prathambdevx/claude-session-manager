// Persistence for all on-disk state: sidecar metadata, tickets, context briefings, and
// live-process tracking read from ~/.claude/sessions/*.json.
import { readdir, readFile, unlink } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  META_PATH, TICKETS_PATH, TODOS_PATH, AGENTS_PATH, TODO_BOARD_PATH,
  GROUP_BOARD_PATH, SAVED_VIEWS_PATH,
  CONTEXTS_DIR, DELEGATIONS_DIR, QUICKPROMPTS_DIR, RUNNING_DIR, PID_LINKS_PATH,
  QUICKPROMPT_TERMINAL_WATCH_TIMEOUT_MS,
} from "./constants.ts";

// Board columns — server-side so they're shared across browsers/tabs.

export type BoardColumn = {
  id: string;
  title: string;
  cwd?: string;
  hidden?: boolean;
  collapsed?: boolean;
};

export async function loadTodoBoard(): Promise<BoardColumn[] | null> {
  try {
    const j = JSON.parse(await readFile(TODO_BOARD_PATH, "utf-8"));
    return Array.isArray(j.columns) ? j.columns : null;
  } catch {
    return null;
  }
}

export async function saveTodoBoard(columns: BoardColumn[]) {
  await Bun.write(TODO_BOARD_PATH, JSON.stringify({ columns }, null, 2));
}

// "Projects" sidebar view — one persisted, manageable column set auto-seeded with a column per project.
export async function loadGroupBoard(): Promise<BoardColumn[] | null> {
  try {
    const j = JSON.parse(await readFile(GROUP_BOARD_PATH, "utf-8"));
    return Array.isArray(j.columns) ? j.columns : null;
  } catch {
    return null;
  }
}

export async function saveGroupBoard(columns: BoardColumn[]) {
  await Bun.write(GROUP_BOARD_PATH, JSON.stringify({ columns }, null, 2));
}

// Saved views — a named, independent column layout you can switch between from the sidebar.

export type SavedView = { id: string; title: string; columns: BoardColumn[] };

export async function loadSavedViews(): Promise<SavedView[]> {
  try {
    const j = JSON.parse(await readFile(SAVED_VIEWS_PATH, "utf-8"));
    return Array.isArray(j.views) ? j.views : [];
  } catch {
    return [];
  }
}

export async function saveSavedViews(views: SavedView[]) {
  await Bun.write(SAVED_VIEWS_PATH, JSON.stringify({ views }, null, 2));
}

const LEGACY_COLUMN_FIELDS = ["isAll", "neverPopulated"];

// Strips legacy column fields (isAll, neverPopulated) left over from older app versions out of
// group-board.json/saved-views.json — a no-op if a file has none. See docs/data-migrations.md.
export async function sanitizeLegacyBoardData(): Promise<void> {
  const stripLegacy = (cols: BoardColumn[]): { cols: BoardColumn[]; changed: boolean } => {
    let changed = false;
    const cleaned = cols.map((c) => {
      const raw = c as Record<string, unknown>;
      if (LEGACY_COLUMN_FIELDS.some((f) => f in raw)) changed = true;
      const { isAll: _isAll, neverPopulated: _neverPopulated, ...rest } = raw;
      return rest as BoardColumn;
    });
    return { cols: cleaned, changed };
  };

  const group = await loadGroupBoard();
  if (group) {
    const { cols, changed } = stripLegacy(group);
    if (changed) {
      await saveGroupBoard(cols);
      console.log("[startup] cleaned legacy column fields from group-board.json");
    }
  }

  const views = await loadSavedViews();
  let viewsChanged = false;
  const cleanedViews = views.map((v) => {
    const { cols, changed } = stripLegacy(v.columns);
    if (changed) viewsChanged = true;
    return { ...v, columns: cols };
  });
  if (viewsChanged) {
    await saveSavedViews(cleanedViews);
    console.log("[startup] cleaned legacy column fields from saved-views.json");
  }
}

// Sidecar metadata (names, tags, notes, status, pinned, archived).

export type Meta = {
  name?: string;
  description?: string;
  descriptionSource?: "manual" | "auto";
  tags?: string[];
  notes?: string;
  status?: "idle" | "in-progress" | "blocked" | "done";
  pinned?: boolean;
  archived?: boolean;
  board?: string; // legacy flat tag, superseded by boardTags — kept for old sessions' meta.json entries
  boardTags?: Record<string, string | null>; // per-board-context column tag, keyed by ctxKey(ctx)
  lastContextId?: string;
  promptHistory?: { text: string; count: number }[]; // Quick Prompt's per-session recency/frequency chips
};

export async function loadMeta(): Promise<Record<string, Meta>> {
  try {
    return JSON.parse(await readFile(META_PATH, "utf-8"));
  } catch {
    return {};
  }
}

export async function saveMeta(meta: Record<string, Meta>) {
  await Bun.write(META_PATH, JSON.stringify(meta, null, 2));
}

// Tickets — note-only board cards, not Claude sessions.

export type Ticket = {
  id: string;
  title: string;
  notes?: string;
  cwd?: string;
  board?: string; // legacy flat tag, superseded by boardTags — kept for old sessions' meta.json entries
  boardTags?: Record<string, string | null>; // per-board-context column tag, keyed by ctxKey(ctx)
  done?: boolean;
  startedSessionId?: string;
  createdAt: number;
};

export async function loadTickets(): Promise<Record<string, Ticket>> {
  try {
    return JSON.parse(await readFile(TICKETS_PATH, "utf-8"));
  } catch {
    return {};
  }
}

export async function saveTickets(tickets: Record<string, Ticket>) {
  await Bun.write(TICKETS_PATH, JSON.stringify(tickets, null, 2));
}

// Todos — standalone task board.

export type Todo = {
  id: string;
  title: string;
  description?: string;
  board?: string;
  status?: "todo" | "in-progress" | "done";
  assignedSessionId?: string;
  createdAt: number;
  updatedAt: number;
};

export async function loadTodos(): Promise<Record<string, Todo>> {
  try {
    return JSON.parse(await readFile(TODOS_PATH, "utf-8"));
  } catch {
    return {};
  }
}

export async function saveTodos(todos: Record<string, Todo>) {
  await Bun.write(TODOS_PATH, JSON.stringify(todos, null, 2));
}

// Context briefings.

export type ContextRecord = {
  id: string;
  sessionId: string;
  cwd: string;
  model: string | null;
  createdAt: number;
  markdown: string;
};

export async function saveContext(ctx: ContextRecord) {
  await Bun.write(join(CONTEXTS_DIR, `${ctx.id}.json`), JSON.stringify(ctx, null, 2));
}

export async function loadContext(id: string): Promise<ContextRecord | null> {
  try {
    return JSON.parse(await readFile(join(CONTEXTS_DIR, `${id}.json`), "utf-8"));
  } catch {
    return null;
  }
}

// Live process tracking (~/.claude/sessions/*.json).

export type RunningInfo = {
  pid: number;
  name?: string;
  status?: string;
  updatedAt?: number;
};

export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export async function loadRunning(): Promise<Record<string, RunningInfo>> {
  const out: Record<string, RunningInfo> = {};
  if (!existsSync(RUNNING_DIR)) return out;
  const files = await readdir(RUNNING_DIR);
  for (const f of files) {
    if (!f.endsWith(".json")) continue;
    try {
      const raw = JSON.parse(await readFile(join(RUNNING_DIR, f), "utf-8"));
      if (raw?.sessionId && pidAlive(raw.pid)) {
        out[raw.sessionId] = {
          pid: raw.pid,
          name: raw.name,
          status: raw.status,
          updatedAt: raw.updatedAt,
        };
      }
    } catch {
      // ignore malformed/stale files
    }
  }
  return out;
}

// Pid → session continuity — bridges /clear, which starts a brand-new transcript id for the same
// running terminal instead of editing the old one in place.

export type PidLinks = Record<string, string>; // pid (as string) -> last-seen sessionId

export async function loadPidLinks(): Promise<PidLinks> {
  try {
    return JSON.parse(await readFile(PID_LINKS_PATH, "utf-8"));
  } catch {
    return {};
  }
}

export async function savePidLinks(links: PidLinks) {
  await Bun.write(PID_LINKS_PATH, JSON.stringify(links, null, 2));
}

const CARRIED_META_FIELDS = ["name", "description", "descriptionSource", "tags", "notes", "status", "pinned", "board"] as const;

// On a /clear, the new transcript id inherits the old one's name/board slot; the old (now-frozen)
// transcript is relabeled "<name> (before clear)" and dropped to the default column.
export type ClearedReconciliation = { oldId: string; newId: string; carriedName?: string };

export async function reconcileClearedSessions(
  running: Record<string, RunningInfo>,
  meta: Record<string, Meta>,
  // Sessions that were never manually renamed have no meta.name to relabel — this lets the caller
  // (routes.ts, which can scan the transcript for a firstMessage-derived title) supply a fallback
  // label so "(before clear)" isn't shown bare with nothing in front of it.
  resolveFallbackLabel?: (sessionId: string) => Promise<string | undefined>
): Promise<{ meta: Record<string, Meta>; changed: boolean; reconciled: ClearedReconciliation[] }> {
  const links = await loadPidLinks();
  const nextLinks: PidLinks = {};
  let changed = false;
  const reconciled: ClearedReconciliation[] = [];

  for (const [sessionId, info] of Object.entries(running)) {
    const pidKey = String(info.pid);
    const prevSessionId = links[pidKey];
    if (prevSessionId && prevSessionId !== sessionId && meta[prevSessionId] && !meta[sessionId]) {
      const prevMeta = meta[prevSessionId];
      const carried: Meta = {};
      for (const field of CARRIED_META_FIELDS) {
        const value = prevMeta[field];
        if (value !== undefined) (carried as Record<string, unknown>)[field] = value;
      }
      if (Object.keys(carried).length) {
        meta[sessionId] = carried; // new session inherits the name + board slot
        const baseLabel = prevMeta.name || (await resolveFallbackLabel?.(prevSessionId));
        meta[prevSessionId] = {
          ...prevMeta,
          name: baseLabel ? `${baseLabel} (before clear)` : "(before clear)",
          board: undefined, // falls back to the first column ("All sessions") instead of its old slot
        };
        changed = true;
        // the still-running terminal (same pid) needs to know its identity moved on too — its
        // caller (routes.ts) uses this to keep an already-open Ghostty window's title/tag in sync
        reconciled.push({ oldId: prevSessionId, newId: sessionId, carriedName: carried.name });
      }
    }
    nextLinks[pidKey] = sessionId;
  }

  await savePidLinks(nextLinks);
  return { meta, changed, reconciled };
}

// Agents — reusable delegation profiles.

export type Agent = {
  id: string;
  name: string;
  emoji: string;
  prompt: string;
  model: string | null;
  permission: "read-only" | "edit";
};

const SEED_AGENTS: Omit<Agent, "id">[] = [
  {
    name: "Research",
    emoji: "🔬",
    prompt:
      "Look at what the session described in the context was working on. Research and think it through, then report the options, tradeoffs, and a concrete recommended plan. Do not edit any files — this is analysis only.",
    model: null,
    permission: "read-only",
  },
  {
    name: "Publish to npm",
    emoji: "📦",
    prompt:
      "Verify the package builds and its tests pass, bump the version appropriately, and publish it to npm. Report exactly what you published (name + version).",
    model: null,
    permission: "edit",
  },
];

export async function loadAgents(): Promise<Record<string, Agent>> {
  try {
    return JSON.parse(await readFile(AGENTS_PATH, "utf-8"));
  } catch {
    // first run — seed the presets so the dock isn't empty
    const seeded: Record<string, Agent> = {};
    for (const a of SEED_AGENTS) {
      const id = crypto.randomUUID();
      seeded[id] = { id, ...a };
    }
    await saveAgents(seeded);
    return seeded;
  }
}

export async function saveAgents(agents: Record<string, Agent>) {
  await Bun.write(AGENTS_PATH, JSON.stringify(agents, null, 2));
}

// Delegations — background agent jobs.

export type Delegation = {
  id: string;
  agentId: string;
  agentName: string;
  agentEmoji: string;
  sessionId: string;
  sessionLabel: string;
  cwd: string;
  status: "running" | "done" | "error";
  createdAt: number;
  finishedAt: number | null;
  result: string | null;
  error: string | null;
  pid: number | null;
  progress: string[]; // live activity log (tool uses + reasoning snippets) parsed from the stream
};

export async function saveDelegation(d: Delegation) {
  await Bun.write(join(DELEGATIONS_DIR, `${d.id}.json`), JSON.stringify(d, null, 2));
}

export async function loadDelegation(id: string): Promise<Delegation | null> {
  try {
    const d: Delegation = JSON.parse(await readFile(join(DELEGATIONS_DIR, `${id}.json`), "utf-8"));
    return reconcileDelegation(d);
  } catch {
    return null;
  }
}

export async function loadAllDelegations(): Promise<Delegation[]> {
  let files: string[] = [];
  try {
    files = (await readdir(DELEGATIONS_DIR)).filter((f) => f.endsWith(".json"));
  } catch {
    return [];
  }
  const out = await Promise.all(files.map((f) => loadDelegation(f.replace(/\.json$/, ""))));
  return out.filter((d): d is Delegation => !!d).sort((a, b) => b.createdAt - a.createdAt);
}

export async function deleteDelegation(id: string) {
  try {
    await unlink(join(DELEGATIONS_DIR, `${id}.json`));
  } catch {
    // already gone
  }
}

// A job left "running" whose process is dead (e.g. server restarted mid-flight) can never finish —
// mark it errored so the UI stops showing a perpetual spinner. Persists the correction.
function reconcileDelegation(d: Delegation): Delegation {
  if (d.status === "running" && d.pid != null && !pidAlive(d.pid)) {
    const fixed: Delegation = { ...d, status: "error", error: "process ended without result", finishedAt: Date.now() };
    saveDelegation(fixed); // fire-and-forget; next read sees the corrected record
    return fixed;
  }
  return d;
}

// Quick prompts — ad-hoc background tasks against a session, no agent/digest.

export type QuickPromptJob = {
  id: string;
  sessionId: string;
  cwd: string;
  prompt: string;
  status: "running" | "done" | "error";
  createdAt: number;
  finishedAt: number | null;
  result: string | null;
  error: string | null;
  pid: number | null;
  progress: string[];
};

export async function saveQuickPromptJob(j: QuickPromptJob) {
  await Bun.write(join(QUICKPROMPTS_DIR, `${j.id}.json`), JSON.stringify(j, null, 2));
}

export async function loadQuickPromptJob(id: string): Promise<QuickPromptJob | null> {
  try {
    const j: QuickPromptJob = JSON.parse(await readFile(join(QUICKPROMPTS_DIR, `${id}.json`), "utf-8"));
    return reconcileQuickPromptJob(j);
  } catch {
    return null;
  }
}

export async function loadAllQuickPromptJobs(): Promise<QuickPromptJob[]> {
  let files: string[] = [];
  try {
    files = (await readdir(QUICKPROMPTS_DIR)).filter((f) => f.endsWith(".json"));
  } catch {
    return [];
  }
  const out = await Promise.all(files.map((f) => loadQuickPromptJob(f.replace(/\.json$/, ""))));
  return out.filter((j): j is QuickPromptJob => !!j).sort((a, b) => b.createdAt - a.createdAt);
}

export async function deleteQuickPromptJob(id: string) {
  try {
    await unlink(join(QUICKPROMPTS_DIR, `${id}.json`));
  } catch {
    // already gone
  }
}

function reconcileQuickPromptJob(j: QuickPromptJob): QuickPromptJob {
  if (j.status === "running" && j.pid != null && !pidAlive(j.pid)) {
    const fixed: QuickPromptJob = { ...j, status: "error", error: "process ended without result", finishedAt: Date.now() };
    saveQuickPromptJob(fixed); // fire-and-forget; next read sees the corrected record
    return fixed;
  }
  // a pid-less job (delivered into an already-open terminal — watched by polling the transcript
  // file, not a subprocess) left "running" past its own wait window means the server most likely
  // restarted mid-wait, losing that in-memory watch loop — flag it rather than spin forever
  if (j.status === "running" && j.pid == null && Date.now() - j.createdAt > QUICKPROMPT_TERMINAL_WATCH_TIMEOUT_MS) {
    const fixed: QuickPromptJob = { ...j, status: "error", error: "stopped watching for a response (server restarted?) — check the terminal directly", finishedAt: Date.now() };
    saveQuickPromptJob(fixed);
    return fixed;
  }
  return j;
}
