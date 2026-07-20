// Everything that talks to the backend HTTP API and mutates the shared session/board state
// afterward — loading, resuming, deleting, launching, delegating.
import {
  sessions, setSessions, agents, setAgents, delegations, setDelegations, todos, setTodos,
  boardMode, activeProjectCwd, boardColumns, projectBoards, setBoardColumns, setProjectBoards,
  currentProjectColumns, setCurrentProjectColumns, groupBoardColumns, setGroupBoardColumns,
  summarizingIds, setContentMatchIds, currentTab,
  PROJECT_DEFAULT_COLUMNS, DEFAULT_COLUMNS, setSavedViews, setQuickPrompts,
} from "../state.js";
import { mergeInProjectColumns } from "../routing/boardRouting.js";
import { toast } from "../ui/toast.js";
import { dangerousDefault } from "../ui/formFragments.js";
import { render, isTransientUiOpen } from "../pages/sessionsPage.js";
import { renderTodoBoard } from "../components/todoBoard/renderTodoBoard.js";
import { applyBoardSettings } from "./boardSettingsApi.js";
import { openConfirmModal } from "../ui/confirmModal.js";

export async function saveBoardColumns() {
  await fetch("/api/board", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ columns: boardColumns }),
  });
}

export async function saveGroupBoardColumns() {
  await fetch("/api/group-board", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ columns: groupBoardColumns }),
  });
}

// background:true (poll/tab-focus refreshes) skips the visual rebuild if a ⋮ menu or rename is
// open — state still updates, only the render is deferred.
export async function loadSessions(opts = {}) {
  const res = await fetch("/api/sessions");
  const data = await res.json();
  // tickets are note-only cards, not Claude sessions — normalize them into the same list shape
  // (isTicket flag) so board/list rendering and drag-drop work uniformly; card renderers branch on it
  const tickets = (data.tickets || []).map((t) => ({
    id: t.id,
    isTicket: true,
    cwd: t.cwd, // undefined when the ticket has no project — it just isn't in any project column
    lastActive: t.createdAt,
    firstMessage: t.title,
    changedFiles: [],
    contextPct: null,
    running: null,
    startedSessionId: t.startedSessionId,
    meta: { name: t.title, notes: t.notes, board: t.board, boardTags: t.boardTags, status: t.done ? "done" : undefined },
  }));
  setSessions([...data.sessions, ...tickets]);
  setAgents(data.agents || []);
  setDelegations(data.delegations || []);
  setTodos(data.todos || []);

  // session board columns: server is the sole source of truth — seed the defaults on a brand-new
  // install only (nothing saved yet)
  let cols;
  if (Array.isArray(data.board) && data.board.length) {
    cols = data.board;
  } else {
    cols = DEFAULT_COLUMNS.slice();
    setBoardColumns(cols);
    await saveBoardColumns();
  }
  setBoardColumns(cols);

  setGroupBoardColumns(Array.isArray(data.groupBoard) ? data.groupBoard : []);
  // no manual "Regroup" button for this view — every project always gets a column, silently,
  // on every load (existing order/hidden/collapsed state for already-present columns untouched)
  const groupMerged = mergeInProjectColumns(groupBoardColumns, data.sessions || []);
  if (groupMerged.changed) {
    setGroupBoardColumns(groupMerged.columns);
    await saveGroupBoardColumns();
  }

  setProjectBoards((data.projectBoards && typeof data.projectBoards === "object") ? data.projectBoards : {});
  if (boardMode === "project" && activeProjectCwd) {
    setCurrentProjectColumns(projectBoards[activeProjectCwd] || PROJECT_DEFAULT_COLUMNS.slice());
  }

  setSavedViews(Array.isArray(data.savedViews) ? data.savedViews : []);
  applyBoardSettings(data.boardSettings);
  setQuickPrompts(Array.isArray(data.quickPrompts) ? data.quickPrompts : []);

  if (opts.background && isTransientUiOpen()) return; // don't rebuild under an open menu/rename
  render();
  if (currentTab === "todos") renderTodoBoard();
}

export async function patchMeta(id, patch) {
  const s = sessions.find((x) => x.id === id);
  if (s) {
    // boardTags is a map of independent per-board slots — a plain spread would replace the whole
    // map with just the incoming key, silently dropping this card's tag in every OTHER board.
    const boardTags = patch.boardTags ? { ...s.meta?.boardTags, ...patch.boardTags } : undefined;
    s.meta = { ...s.meta, ...patch, ...(boardTags ? { boardTags } : {}) };
  }
  render();
  if (s?.isTicket) {
    // tickets persist to their own store; map meta fields onto ticket fields
    const body = {};
    if ("name" in patch) body.title = patch.name;
    if ("notes" in patch) body.notes = patch.notes;
    if ("board" in patch) body.board = patch.board;
    if ("boardTags" in patch) body.boardTags = patch.boardTags;
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
  } else if (data.busy) {
    // a headless quick prompt is still running on this session — don't copy a command or imply a
    // failure; just tell the user to wait so they don't start a second process on the transcript
    toast(data.error || "A quick prompt is running in the background — wait for it to finish, then resume.");
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

export async function closeSessionTerminal(id, title) {
  const ok = await openConfirmModal({
    title: `Close terminal for "${title || id}"?`,
    message: "The session itself isn't deleted — just its open terminal window.",
    confirmLabel: "Close terminal",
    danger: true,
  });
  if (!ok) return;
  const res = await fetch(`/api/sessions/${id}/close-terminal`, { method: "POST" });
  const data = await res.json();
  toast(data.closed ? "Terminal closed" : "No terminal window was open for this session");
  loadSessions();
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
