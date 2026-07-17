// Everything that talks to the backend HTTP API and mutates the shared session/board state
// afterward — loading, resuming, deleting, launching, delegating.
import {
  sessions, setSessions, agents, setAgents, delegations, setDelegations, todos, setTodos,
  boardMode, activeProjectCwd, boardColumns, projectBoards, setBoardColumns, setProjectBoards,
  currentProjectColumns, setCurrentProjectColumns, summarizingIds, setContentMatchIds, currentTab,
  DEFAULT_COLUMNS, setSavedViews,
} from "../state.js";
import { migrateColumns, mergeInProjectColumns, carryTransientColumnFlags } from "../routing/boardRouting.js";
import { toast } from "../ui/toast.js";
import { dangerousDefault } from "../ui/formFragments.js";
import { render } from "../pages/sessionsPage.js";
import { renderTodoBoard } from "../components/todoBoard/renderTodoBoard.js";
import { escapeHtml, escapeAttr } from "../ui/format.js";
import { applyBoardSettings } from "./boardSettingsApi.js";
import { openConfirmModal } from "../ui/confirmModal.js";

// ---------- project filter dropdown ----------
// Launching lives entirely in the per-column "+" New Task modal; this dropdown scopes the
// visible board/list to one project's sessions.
export async function loadProjects() {
  const res = await fetch("/api/projects");
  const data = await res.json();
  const sel = document.getElementById("filterProject");
  const current = sel.value;
  sel.innerHTML =
    '<option value="">All projects</option>' +
    data.projects.map((p) => `<option value="${escapeAttr(p)}">${escapeHtml(p)}</option>`).join("");
  if (current && data.projects.includes(current)) sel.value = current; // preserve selection across refreshes
}

export async function saveBoardColumns() {
  await fetch("/api/board", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ columns: boardColumns }),
  });
}

export async function loadSessions() {
  const res = await fetch("/api/sessions");
  const data = await res.json();
  // tickets are note-only cards, not Claude sessions — normalize them into the same list shape
  // (isTicket flag) so board/list rendering and drag-drop work uniformly; card renderers branch on it
  const tickets = (data.tickets || []).map((t) => ({
    id: t.id,
    isTicket: true,
    cwd: t.cwd || "🎫 Tickets", // sentinel so list-view grouping shows them under one header
    lastActive: t.createdAt,
    firstMessage: t.title,
    changedFiles: [],
    contextPct: null,
    running: null,
    startedSessionId: t.startedSessionId,
    meta: { name: t.title, notes: t.notes, board: t.board, status: t.done ? "done" : undefined },
  }));
  setSessions([...data.sessions, ...tickets]);
  setAgents(data.agents || []);
  setDelegations(data.delegations || []);
  setTodos(data.todos || []);

  // session board columns: server is source of truth; migrate localStorage on first run
  let cols;
  if (Array.isArray(data.board) && data.board.length) {
    cols = carryTransientColumnFlags(boardColumns, migrateColumns(data.board));
  } else {
    const legacy = JSON.parse(localStorage.getItem("boardColumns") || "null");
    cols = carryTransientColumnFlags(boardColumns, migrateColumns(legacy && legacy.length ? legacy : [{ id: "todo", title: "All sessions" }]));
    setBoardColumns(cols);
    await saveBoardColumns();
  }
  setBoardColumns(cols);

  // One-time (per browser): ensure every project currently in use has its own column, without
  // ever touching existing columns — a fresh install starts from just "All sessions" above, so
  // this fills it out to "All sessions" + one column per project; an existing install's own
  // Priority/In Progress/etc columns are preserved exactly and project columns are appended
  // alongside them. Gated on a flag so a later deliberate removal of a project's column isn't
  // resurrected on the next poll.
  if (!localStorage.getItem("projectColumnsMigrated")) {
    const merged = mergeInProjectColumns(cols, data.sessions || []);
    if (merged.changed) {
      setBoardColumns(merged.columns);
      await saveBoardColumns();
    }
    localStorage.setItem("projectColumnsMigrated", "1");
  }

  setProjectBoards((data.projectBoards && typeof data.projectBoards === "object") ? data.projectBoards : {});
  if (boardMode === "project" && activeProjectCwd) {
    setCurrentProjectColumns(carryTransientColumnFlags(currentProjectColumns, projectBoards[activeProjectCwd] || DEFAULT_COLUMNS.slice()));
  }

  setSavedViews(Array.isArray(data.savedViews) ? data.savedViews : []);
  applyBoardSettings(data.boardSettings);

  render();
  if (currentTab === "todos") renderTodoBoard();
}

export async function patchMeta(id, patch) {
  const s = sessions.find((x) => x.id === id);
  if (s) s.meta = { ...s.meta, ...patch };
  render();
  if (s?.isTicket) {
    // tickets persist to their own store; map meta fields onto ticket fields
    const body = {};
    if ("name" in patch) body.title = patch.name;
    if ("notes" in patch) body.notes = patch.notes;
    if ("board" in patch) body.board = patch.board;
    if ("cwd" in patch) body.cwd = patch.cwd;
    if ("status" in patch) body.done = patch.status === "done";
    if ("startedSessionId" in patch) body.startedSessionId = patch.startedSessionId;
    await fetch(`/api/tickets/${id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return;
  }
  await fetch(`/api/sessions/${id}/meta`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(patch),
  });
}

export async function resumeSession(id, fork) {
  const res = await fetch(`/api/sessions/${id}/resume`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ fork: !!fork, dangerous: dangerousDefault() }),
  });
  const data = await res.json();
  if (data.ok) {
    if (data.focused) {
      toast("Already running — switched to its terminal window");
    } else {
      toast((fork ? "Forked → " : "Resuming → ") + data.command);
    }
  } else {
    toast("Failed to launch terminal — copied command instead");
    copyCommand(id, fork);
  }
}

export async function summarizeSession(id) {
  if (summarizingIds.has(id)) return;
  summarizingIds.add(id);
  render();
  try {
    const res = await fetch(`/api/sessions/${id}/summarize`, { method: "POST" });
    const data = await res.json();
    if (data.ok) {
      const s = sessions.find((x) => x.id === id);
      if (s) s.meta = { ...s.meta, description: data.description, descriptionSource: "auto" };
      toast("Summarized");
    } else {
      toast("Couldn't summarize: " + (data.error || "unknown error"));
    }
  } catch (e) {
    toast("Couldn't summarize: " + e.message);
  } finally {
    summarizingIds.delete(id);
    render();
  }
}

export function copyCommand(id, fork) {
  const cmd = `claude --resume ${id}${fork ? " --fork-session" : ""}`;
  navigator.clipboard.writeText(cmd);
  toast("Copied: " + cmd);
}

export async function deleteSession(id, title) {
  const s = sessions.find((x) => x.id === id);
  if (s?.isTicket) {
    const ok = await openConfirmModal({ title: `Delete ticket "${title || id}"?`, confirmLabel: "Delete", danger: true });
    if (!ok) return;
    await fetch(`/api/tickets/${id}`, { method: "DELETE" });
    setSessions(sessions.filter((x) => x.id !== id));
    render();
    toast("Ticket deleted");
    return;
  }
  const ok = await openConfirmModal({
    title: `Delete session "${title || id}"?`,
    message: "This deletes the transcript permanently — cannot be undone.",
    confirmLabel: "Delete",
    danger: true,
  });
  if (!ok) return;
  await fetch(`/api/sessions/${id}`, { method: "DELETE" });
  setSessions(sessions.filter((x) => x.id !== id));
  render();
  toast("Deleted");
}

export async function fetchContentMatches(q) {
  if (q.trim().length < 2) { setContentMatchIds(new Set()); render(); return; }
  try {
    const res = await fetch(`/api/search?q=${encodeURIComponent(q.trim())}`);
    const data = await res.json();
    setContentMatchIds(new Set(data.ids || []));
  } catch {
    setContentMatchIds(new Set());
  }
  render();
}

export async function launchTask({ cwd, task, name, model, mode, dangerous = true }) {
  if (!cwd) { toast("Pick a project first"); return; }
  if (!task) { toast("Describe the task first"); return; }
  const res = await fetch("/api/launch", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ cwd, task, mode, name: name || undefined, model: model || undefined, dangerous }),
  });
  const data = await res.json();
  if (data.ok) {
    toast(`Launched${name ? ' "' + name + '"' : ""} in ${cwd}${mode === "implement-review" ? " (implement → review)" : ""}`);
  } else {
    toast("Failed to launch: " + (data.error || "unknown error"));
  }
  return data;
}

export async function startDelegation(agentId, sessionId) {
  const agent = agents.find((a) => a.id === agentId);
  const s = sessions.find((x) => x.id === sessionId);
  toast(`Delegating to ${agent?.emoji || ""} ${agent?.name || "agent"}…`);
  try {
    const res = await fetch("/api/delegations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ agentId, sessionId }),
    });
    const data = await res.json();
    if (data.ok) {
      toast(`⏳ ${agent?.name || "Agent"} running in background on "${(s?.meta?.name || s?.firstMessage || "").slice(0, 40)}"`);
      loadSessions(); // pick up the new running job chip
    } else {
      toast("Delegation failed: " + (data.error || "unknown error"));
    }
  } catch (e) {
    toast("Delegation failed: " + e.message);
  }
}
