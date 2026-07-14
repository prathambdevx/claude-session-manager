const API = "";
let sessions = [];
let agents = [];
let delegations = [];
// global "run dangerously" default — drives resume/fork directly and pre-checks per-launch modals.
// defaults ON (matches the tool's dangerous-by-default behavior) unless the user turned it off.
function dangerousDefault() {
  return localStorage.getItem("globalDangerous") !== "0";
}
let collapsedProjects = new Set(JSON.parse(localStorage.getItem("collapsedProjects") || "[]"));
let expandedCards = new Set();
let summarizingIds = new Set();
let currentView = localStorage.getItem("currentView") || "list";
const DEFAULT_COLUMNS = [
  { id: "todo", title: "All sessions" },
  { id: "in-progress", title: "In Progress" },
  { id: "priority", title: "Priority" },
  { id: "research", title: "Research" },
  { id: "done", title: "Done" },
];
const OLD_DEFAULT_ORDER = ["todo", "priority", "research", "in-progress", "done"];
let boardColumns = JSON.parse(localStorage.getItem("boardColumns") || "null") || DEFAULT_COLUMNS;
if (boardColumns.map((c) => c.id).join(",") === OLD_DEFAULT_ORDER.join(",")) {
  boardColumns = DEFAULT_COLUMNS; // pick up the new column order for anyone with the old default saved
}
const todoCol = boardColumns.find((c) => c.id === "todo");
if (todoCol && todoCol.title === "To Do") todoCol.title = "All sessions"; // pick up the renamed default for existing boards
function saveBoardColumns() { localStorage.setItem("boardColumns", JSON.stringify(boardColumns)); }

function toast(msg) {
  const t = document.getElementById("toast");
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.remove("show"), 1800);
}

async function loadSessions() {
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
    meta: { name: t.title, notes: t.notes, board: t.board, status: t.done ? "done" : undefined },
  }));
  sessions = [...data.sessions, ...tickets];
  agents = data.agents || [];
  delegations = data.delegations || [];
  render();
}

async function patchMeta(id, patch) {
  const s = sessions.find((x) => x.id === id);
  if (s) s.meta = { ...s.meta, ...patch };
  render();
  if (s?.isTicket) {
    // tickets persist to their own store; map meta fields onto ticket fields
    const body = {};
    if ("name" in patch) body.title = patch.name;
    if ("notes" in patch) body.notes = patch.notes;
    if ("board" in patch) body.board = patch.board;
    if ("status" in patch) body.done = patch.status === "done";
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

async function resumeSession(id, fork) {
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

async function summarizeSession(id) {
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

function copyCommand(id, fork) {
  const cmd = `claude --resume ${id}${fork ? " --fork-session" : ""}`;
  navigator.clipboard.writeText(cmd);
  toast("Copied: " + cmd);
}

async function deleteSession(id, title) {
  const s = sessions.find((x) => x.id === id);
  if (s?.isTicket) {
    if (!confirm(`Delete ticket "${title || id}"?`)) return;
    await fetch(`/api/tickets/${id}`, { method: "DELETE" });
    sessions = sessions.filter((x) => x.id !== id);
    render();
    toast("Ticket deleted");
    return;
  }
  if (!confirm(`Delete session "${title || id}"? This deletes the transcript permanently — cannot be undone.`)) return;
  await fetch(`/api/sessions/${id}`, { method: "DELETE" });
  sessions = sessions.filter((x) => x.id !== id);
  render();
  toast("Deleted");
}

function fmtTime(ms) {
  const d = new Date(ms);
  const now = Date.now();
  const diffH = (now - ms) / 3600000;
  if (diffH < 24) return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  if (diffH < 24 * 7) return d.toLocaleDateString([], { weekday: "short" }) + " " + d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  return d.toLocaleDateString([], { month: "short", day: "numeric", year: "numeric" });
}

function projectName(cwd) {
  const parts = cwd.split("/").filter(Boolean);
  return parts[parts.length - 1] || cwd;
}

let contentMatchIds = new Set();
let contentSearchTimer = null;
async function fetchContentMatches(q) {
  if (q.trim().length < 2) { contentMatchIds = new Set(); render(); return; }
  try {
    const res = await fetch(`/api/search?q=${encodeURIComponent(q.trim())}`);
    const data = await res.json();
    contentMatchIds = new Set(data.ids || []);
  } catch {
    contentMatchIds = new Set();
  }
  render();
}

function matchesSearch(s, q) {
  if (!q) return true;
  q = q.toLowerCase();
  const hay = [
    s.meta?.name, s.meta?.description, s.firstMessage, s.cwd, s.gitBranch,
    ...(s.meta?.tags || []), s.meta?.notes, s.id,
  ].filter(Boolean).join(" ").toLowerCase();
  return hay.includes(q) || contentMatchIds.has(s.id);
}

function render() {
  const q = document.getElementById("search").value.trim();
  const sortMode = document.getElementById("sort").value;
  const dateFilter = document.getElementById("filterDate").value;
  const projectFilter = document.getElementById("filterProject").value;
  const dateCutoff = dateFilter ? Date.now() - Number(dateFilter) * 86400000 : null;

  let filtered = sessions.filter((s) => {
    if (projectFilter && s.cwd !== projectFilter) return false;
    if (dateCutoff && s.lastActive < dateCutoff) return false;
    return matchesSearch(s, q);
  });

  document.getElementById("statLine").textContent =
    `${filtered.length} session${filtered.length === 1 ? "" : "s"} shown · ${sessions.filter(s => s.running).length} currently running`;

  if (currentView === "board") {
    renderBoardView(filtered);
    return;
  }
  renderListView(filtered, sortMode);
}

function renderListView(filtered, sortMode) {
  // group by cwd
  const groups = new Map();
  for (const s of filtered) {
    const key = s.cwd;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(s);
  }

  // running sessions win ties (you're interacting with them right now); then most-recent mtime
  const byRecency = (a, b) => (b.running ? 1 : 0) - (a.running ? 1 : 0) || b.lastActive - a.lastActive;
  const sortFns = {
    recent: byRecency,
    oldest: (a, b) => a.lastActive - b.lastActive,
    messages: (a, b) => b.messageCount - a.messageCount,
    project: (a, b) => a.cwd.localeCompare(b.cwd),
  };
  for (const arr of groups.values()) arr.sort(sortFns[sortMode]);

  let projectEntries = [...groups.entries()];
  if (sortMode === "project") {
    projectEntries.sort((a, b) => a[0].localeCompare(b[0]));
  } else {
    // order groups by their most-recent session
    projectEntries.sort((a, b) => Math.max(...b[1].map(s => s.lastActive)) - Math.max(...a[1].map(s => s.lastActive)));
  }

  const app = document.getElementById("app");
  if (!projectEntries.length) {
    app.innerHTML = '<div class="empty">No sessions match.</div>';
    return;
  }

  app.innerHTML = projectEntries.map(([cwd, list]) => {
    const collapsed = collapsedProjects.has(cwd);
    const pinnedCount = list.filter(s => s.meta?.pinned).length;
    list.sort((a, b) => (b.meta?.pinned ? 1 : 0) - (a.meta?.pinned ? 1 : 0));
    return `
      <div class="project-group">
        <div class="project-header ${collapsed ? "collapsed" : ""}" data-cwd="${escapeAttr(cwd)}">
          <span class="chev">▾</span>
          <span>${escapeHtml(projectName(cwd))}</span>
          <span class="count">— ${escapeHtml(cwd)} · ${list.length} session${list.length === 1 ? "" : "s"}${pinnedCount ? " · " + pinnedCount + " pinned" : ""}</span>
        </div>
        <div class="cards ${collapsed ? "collapsed" : ""}">
          ${list.map(cardHtml).join("")}
        </div>
      </div>
    `;
  }).join("");

  app.querySelectorAll(".project-header").forEach((el) => {
    el.addEventListener("click", () => {
      const cwd = el.dataset.cwd;
      if (collapsedProjects.has(cwd)) collapsedProjects.delete(cwd);
      else collapsedProjects.add(cwd);
      localStorage.setItem("collapsedProjects", JSON.stringify([...collapsedProjects]));
      render();
    });
  });

  app.querySelectorAll("[data-action]").forEach((el) => {
    el.addEventListener("click", (e) => {
      e.stopPropagation();
      const { action, id } = el.dataset;
      const s = sessions.find(x => x.id === id);
      const title = s?.meta?.name || s?.firstMessage || id;
      if (action === "resume") resumeSession(id, false);
      if (action === "fork") resumeSession(id, true);
      if (action === "copy") copyCommand(id, false);
      if (action === "delete") deleteSession(id, title);
      if (action === "pin") patchMeta(id, { pinned: !s.meta?.pinned });
      if (action === "toggleDetails") { toggleDetails(id); }
      if (action === "summarize") summarizeSession(id);
      if (action === "review") openReviewModal(id);
      if (action === "extract") openExtractModal(id);
      if (action === "ticket-done") patchMeta(id, { status: s?.meta?.status === "done" ? undefined : "done" });
      if (action === "ticket-convert") convertTicketToSession(id);
      if (action === "rename") {
        const next = prompt("Rename ticket:", s?.meta?.name || "");
        if (next !== null) patchMeta(id, { name: next.trim() || undefined });
      }
      if (action === "rename-focus") {
        const input = app.querySelector(`input[data-name-edit="${id}"]`);
        if (input) { input.focus(); input.select(); }
      }
    });
  });

  app.querySelectorAll("[data-name-edit]").forEach((el) => {
    el.addEventListener("blur", () => patchMeta(el.dataset.nameEdit, { name: el.value.trim() || undefined }));
    el.addEventListener("keydown", (e) => { if (e.key === "Enter") el.blur(); });
  });
  app.querySelectorAll("[data-description-edit]").forEach((el) => {
    el.addEventListener("blur", () => {
      const val = el.value.trim();
      patchMeta(el.dataset.descriptionEdit, { description: val || undefined, descriptionSource: val ? "manual" : undefined });
    });
    el.addEventListener("keydown", (e) => { if (e.key === "Enter") el.blur(); });
  });
  app.querySelectorAll("[data-tags-edit]").forEach((el) => {
    el.addEventListener("blur", () => {
      const tags = el.value.split(",").map(t => t.trim()).filter(Boolean);
      patchMeta(el.dataset.tagsEdit, { tags });
    });
    el.addEventListener("keydown", (e) => { if (e.key === "Enter") el.blur(); });
  });
  app.querySelectorAll("[data-notes-edit]").forEach((el) => {
    el.addEventListener("blur", () => patchMeta(el.dataset.notesEdit, { notes: el.value.trim() || undefined }));
  });
}

function boardCardHtml(s) {
  if (s.isTicket) return ticketCardHtml(s);
  const title = s.meta?.name || (s.firstMessage ? s.firstMessage.slice(0, 50) : "(untitled)");
  const desc = s.meta?.description;
  const isLive = !!s.running;
  const isAuto = s.meta?.descriptionSource === "auto";
  const summarizing = summarizingIds.has(s.id);
  return `
    <div class="board-card" draggable="true" data-card-id="${s.id}">
      <div class="bc-title">
        <span class="dot ${isLive ? "live" : "idle"}" style="margin-top:0"></span>
        <span style="flex:1; min-width:0; overflow-wrap:anywhere;">${escapeHtml(title)}</span>
        <span class="rename-pencil" data-action="rename" data-id="${s.id}" title="Rename">✎</span>
      </div>
      <div class="bc-desc" style="display:flex; align-items:baseline; gap:5px; ${desc ? "" : "font-style:italic; color:var(--dim);"}">
        <span style="flex:1; min-width:0; overflow-wrap:anywhere;">${escapeHtml(desc || "no description yet")}</span>
        ${isAuto ? '<span class="auto-tag">auto</span>' : ""}
        <button class="summarize-btn ${summarizing ? "loading" : ""}" data-action="summarize" data-id="${s.id}" title="Auto-generate a short description from this session's messages">${summarizing ? "…" : "✨"}</button>
      </div>
      <div class="bc-meta">
        <span class="chip">${escapeHtml(projectName(s.cwd))}</span>
        ${s.gitBranch ? `<span class="chip branch">${escapeHtml(s.gitBranch)}</span>` : ""}
        ${ctxBadgeHtml(s)}
      </div>
      <div class="bc-actions">
        <button data-action="resume" data-id="${s.id}">▶ Resume</button>
        <button data-action="fork" data-id="${s.id}">⑂ Fork</button>
        <button data-action="review" data-id="${s.id}" title="Send this session's changed files to a reviewer agent">🔎 Review</button>
        <button data-action="extract" data-id="${s.id}" title="Condense this session into a briefing for a fresh session">🧠 Extract</button>
        <button class="danger" data-action="delete" data-id="${s.id}">🗑</button>
      </div>
    </div>
  `;
}

function ticketCardHtml(s) {
  const title = s.meta?.name || "(untitled ticket)";
  const notes = s.meta?.notes;
  const done = s.meta?.status === "done";
  return `
    <div class="board-card ticket-card ${done ? "ticket-done" : ""}" draggable="true" data-card-id="${s.id}">
      <div class="bc-title">
        <span class="ticket-tag">TICKET</span>
        <span style="flex:1; min-width:0; overflow-wrap:anywhere; ${done ? "text-decoration:line-through; opacity:0.6;" : ""}">${escapeHtml(title)}</span>
        <span class="rename-pencil" data-action="rename" data-id="${s.id}" title="Rename">✎</span>
      </div>
      ${notes ? `<div class="bc-desc"><span style="flex:1; overflow-wrap:anywhere;">${escapeHtml(notes)}</span></div>` : ""}
      <div class="bc-actions">
        <button data-action="ticket-done" data-id="${s.id}">${done ? "↩ Reopen" : "✓ Done"}</button>
        <button data-action="ticket-convert" data-id="${s.id}" title="Start a Claude session from this ticket">▶ Start session</button>
        <button class="danger" data-action="delete" data-id="${s.id}">🗑</button>
      </div>
    </div>
  `;
}

function renderBoardView(filtered) {
  const app = document.getElementById("app");
  const byColumn = new Map(boardColumns.map((c) => [c.id, []]));
  for (const s of filtered) {
    const col = s.meta?.board && byColumn.has(s.meta.board) ? s.meta.board : boardColumns[0]?.id;
    if (col && byColumn.has(col)) byColumn.get(col).push(s);
  }
  // running-first, then most recent — same rule as list view so a session you just touched floats up
  const byRecency = (a, b) => (b.running ? 1 : 0) - (a.running ? 1 : 0) || b.lastActive - a.lastActive;
  for (const arr of byColumn.values()) arr.sort(byRecency);

  app.innerHTML = `
    ${agentsDockHtml()}
    <div class="board">
      ${boardColumns.map((c) => `
        <div class="board-col" data-col-id="${c.id}">
          <div class="board-col-header" draggable="true" data-col-drag="${c.id}" title="Drag to reorder columns">
            <span class="drag-handle">⠿</span>
            <span>${escapeHtml(c.title)}</span>
            <span class="board-count">${(byColumn.get(c.id) || []).length}</span>
            <span class="rename-pencil" data-add-col-task="${c.id}" title="Start a new task in this column" style="margin-left:auto; font-weight:700; font-size:14px;">+</span>
            <span class="rename-pencil" data-rename-col="${c.id}" title="Rename column">✎</span>
            <span class="remove-col" data-remove-col="${c.id}" title="Remove column">✕</span>
          </div>
          <div class="board-col-body" data-col-drop="${c.id}">
            ${(byColumn.get(c.id) || []).map(boardCardHtml).join("") || '<div class="empty" style="padding:16px 0;">Drop here</div>'}
          </div>
        </div>
      `).join("")}
      <button class="add-col-btn" id="addColBtn">+ Add column</button>
    </div>
  `;

  app.querySelectorAll("[data-action]").forEach((el) => {
    el.addEventListener("click", (e) => {
      e.stopPropagation();
      const { action, id } = el.dataset;
      const s = sessions.find((x) => x.id === id);
      const title = s?.meta?.name || s?.firstMessage || id;
      if (action === "resume") resumeSession(id, false);
      if (action === "fork") resumeSession(id, true);
      if (action === "delete") deleteSession(id, title);
      if (action === "review") openReviewModal(id);
      if (action === "extract") openExtractModal(id);
      if (action === "summarize") summarizeSession(id);
      if (action === "ticket-done") patchMeta(id, { status: s?.meta?.status === "done" ? undefined : "done" });
      if (action === "ticket-convert") convertTicketToSession(id);
      if (action === "rename") {
        const next = prompt(s?.isTicket ? "Rename ticket:" : "Rename session:", s?.meta?.name || "");
        if (next !== null) patchMeta(id, { name: next.trim() || undefined });
      }
    });
  });

  app.querySelectorAll("[data-add-col-task]").forEach((el) => {
    el.addEventListener("click", (e) => {
      e.stopPropagation();
      openColumnTaskModal(el.dataset.addColTask);
    });
  });

  app.querySelectorAll("[data-rename-col]").forEach((el) => {
    el.addEventListener("click", (e) => {
      e.stopPropagation();
      const id = el.dataset.renameCol;
      const col = boardColumns.find((c) => c.id === id);
      const next = prompt("Rename column:", col?.title || "");
      if (next === null || !next.trim()) return;
      col.title = next.trim();
      saveBoardColumns();
      render();
    });
  });

  app.querySelectorAll("[data-remove-col]").forEach((el) => {
    el.addEventListener("click", (e) => {
      e.stopPropagation();
      const id = el.dataset.removeCol;
      const col = boardColumns.find((c) => c.id === id);
      if (!confirm(`Remove column "${col?.title}"? Sessions in it move back to "${boardColumns[0].title}".`)) return;
      boardColumns = boardColumns.filter((c) => c.id !== id);
      saveBoardColumns();
      render();
    });
  });

  document.getElementById("addColBtn")?.addEventListener("click", () => {
    const title = prompt("New column name:");
    if (!title || !title.trim()) return;
    const base = title.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "") || "col";
    let id = base;
    let n = 2;
    while (boardColumns.some((c) => c.id === id)) { id = `${base}-${n++}`; } // ids can collide with a renamed column's stable id even when titles differ
    boardColumns.push({ id, title: title.trim() });
    saveBoardColumns();
    render();
  });

  // drag & drop — cards move between columns, column headers reorder columns
  app.querySelectorAll(".board-card").forEach((card) => {
    card.addEventListener("dragstart", (e) => {
      e.stopPropagation();
      card.classList.add("dragging");
      e.dataTransfer.setData("text/plain", "card:" + card.dataset.cardId);
      e.dataTransfer.effectAllowed = "move";
    });
    card.addEventListener("dragend", () => card.classList.remove("dragging"));
  });

  app.querySelectorAll("[data-col-drag]").forEach((handle) => {
    handle.addEventListener("dragstart", (e) => {
      e.stopPropagation();
      e.dataTransfer.setData("text/plain", "col:" + handle.dataset.colDrag);
      e.dataTransfer.effectAllowed = "move";
      handle.closest(".board-col").classList.add("dragging");
    });
    handle.addEventListener("dragend", () => handle.closest(".board-col")?.classList.remove("dragging"));
  });

  app.querySelectorAll(".board-col").forEach((col) => {
    col.addEventListener("dragover", (e) => {
      e.preventDefault();
      col.classList.add("dragover");
    });
    col.addEventListener("dragleave", () => col.classList.remove("dragover"));
    col.addEventListener("drop", (e) => {
      e.preventDefault();
      col.classList.remove("dragover");
      const payload = e.dataTransfer.getData("text/plain");
      const colId = col.dataset.colId;
      if (payload.startsWith("col:")) {
        const draggedId = payload.slice(4);
        if (draggedId === colId) return;
        const fromIdx = boardColumns.findIndex((c) => c.id === draggedId);
        const toIdx = boardColumns.findIndex((c) => c.id === colId);
        if (fromIdx === -1 || toIdx === -1) return;
        const [moved] = boardColumns.splice(fromIdx, 1);
        boardColumns.splice(toIdx, 0, moved);
        saveBoardColumns();
        render();
        return;
      }
      const cardId = payload.replace(/^card:/, "");
      const s = sessions.find((x) => x.id === cardId);
      if (s) s.meta = { ...s.meta, board: colId };
      render();
      patchMeta(cardId, { board: colId });
    });
  });

  wireAgentsDock(app);
}

// ---------- Agents dock (board-only band above the columns) ----------

function agentsDockHtml() {
  const collapsed = localStorage.getItem("agentsDockCollapsed") === "1";
  const recent = delegations.slice(0, 8);
  const jobChip = (d) => {
    const icon = d.status === "done" ? "✓" : d.status === "error" ? "✗" : "⏳";
    const cls = d.status === "done" ? "job-done" : d.status === "error" ? "job-error" : "job-running";
    // every chip (running too) opens the detail modal — running shows the live activity feed
    return `<span class="job-chip ${cls}" data-open-delegation="${d.id}" title="${escapeAttr(d.agentName + " → " + d.sessionLabel)} — click for details">
      ${icon} ${escapeHtml(d.agentEmoji)} ${escapeHtml(d.sessionLabel.slice(0, 24))}</span>`;
  };
  return `
    <div class="agents-dock ${collapsed ? "collapsed" : ""}" id="agentsDock">
      <div class="dock-row">
        <span class="dock-label" id="agentsDockToggle" title="Collapse/expand">AGENTS ${collapsed ? "▸" : "▾"}</span>
        ${agents
          .map(
            (a) => `<div class="agent-tile" data-agent-drop="${a.id}" data-agent-edit="${a.id}" title="${escapeAttr(a.prompt.slice(0, 120))} — drop a session to delegate; click to edit">
              <span>${escapeHtml(a.emoji)}</span> <span>${escapeHtml(a.name)}</span>
              <span class="agent-perm ${a.permission === "edit" ? "perm-edit" : "perm-ro"}">${a.permission === "edit" ? "✎" : "👁"}</span>
            </div>`
          )
          .join("")}
        <div class="agent-tile agent-new" id="agentNewTile" title="Create a new agent">＋ New agent</div>
      </div>
      <div class="dock-row dock-jobs">
        <span class="dock-label">JOBS</span>
        ${recent.length ? recent.map(jobChip).join("") : '<span class="dock-empty">no delegations yet — drop a session on an agent</span>'}
        <a class="dock-all" href="/delegations" target="_blank" rel="noopener">all ↗</a>
      </div>
    </div>
  `;
}

function wireAgentsDock(app) {
  const dock = app.querySelector("#agentsDock");
  if (!dock) return;

  app.querySelector("#agentsDockToggle")?.addEventListener("click", () => {
    const now = !dock.classList.contains("collapsed");
    localStorage.setItem("agentsDockCollapsed", now ? "1" : "0");
    render();
  });

  app.querySelector("#agentNewTile")?.addEventListener("click", () => openAgentModal(null));

  app.querySelectorAll("[data-agent-edit]").forEach((el) => {
    el.addEventListener("click", (e) => {
      // ignore clicks that are actually the start of a drag-drop target interaction
      if (e.defaultPrevented) return;
      openAgentModal(el.dataset.agentEdit);
    });
  });

  app.querySelectorAll("[data-open-delegation]").forEach((el) => {
    el.addEventListener("click", () => openDelegationModal(el.dataset.openDelegation));
  });

  // each agent tile is a drop target — dropping a session delegates it to that agent
  app.querySelectorAll("[data-agent-drop]").forEach((tile) => {
    tile.addEventListener("dragover", (e) => {
      e.preventDefault();
      tile.classList.add("dragover");
    });
    tile.addEventListener("dragleave", () => tile.classList.remove("dragover"));
    tile.addEventListener("drop", (e) => {
      e.preventDefault();
      tile.classList.remove("dragover");
      const payload = e.dataTransfer.getData("text/plain");
      if (!payload.startsWith("card:")) return;
      const sessionId = payload.slice(5);
      const s = sessions.find((x) => x.id === sessionId);
      if (s?.isTicket) { toast("Tickets can't be delegated — start a session from it first"); return; }
      startDelegation(tile.dataset.agentDrop, sessionId);
    });
  });
}

async function startDelegation(agentId, sessionId) {
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

function openAgentModal(agentId) {
  const a = agentId ? agents.find((x) => x.id === agentId) : null;
  const editing = !!a;
  modalShell(`
    <h3>${editing ? "✎ Edit agent" : "＋ New agent"}</h3>
    <div class="modal-row" style="flex-direction:row; gap:8px;">
      <input type="text" id="agEmoji" style="width:64px; text-align:center;" placeholder="🤖" value="${escapeAttr(a?.emoji || "")}" />
      <input type="text" id="agName" style="flex:1;" placeholder="Agent name (e.g. Publish, Changelog)" value="${escapeAttr(a?.name || "")}" />
    </div>
    <div class="modal-row">
      <label for="agPrompt">Instruction — what this agent does with the delegated session</label>
      <textarea id="agPrompt" class="notes-input" style="min-height:200px; font-size:13px;" placeholder="e.g. Review these changes for security bugs and edge cases, and write tests covering them.

The agent already inherits your shell auth (gh, npm login, etc.), so it can usually push/publish without any token. If a task needs a specific credential, you can paste it here (GitHub PAT, npm token, API key…) and tell the agent to use it — e.g. 'publish with npm token npm_xxx'.">${escapeHtml(a?.prompt || "")}</textarea>
    </div>
    <div class="modal-row">
      <label for="agModel">Model</label>
      ${modelSelectHtml("agModel", a?.model || "")}
    </div>
    <div class="modal-row">
      <label>Permission</label>
      <div class="mode-toggle">
        <button id="agPermRO" class="${!a || a.permission === "read-only" ? "active" : ""}" data-perm="read-only" title="Can read the repo, search, run commands — cannot edit files">👁 Read-only</button>
        <button id="agPermEdit" class="${a && a.permission === "edit" ? "active" : ""}" data-perm="edit" title="Full write access, dangerous mode — for publish/codegen/fixes">✎ Can edit files</button>
      </div>
    </div>
    <div class="modal-actions">
      ${editing ? `<button class="danger" id="agDelete">🗑 Delete</button>` : ""}
      <span style="flex:1"></span>
      <button id="agCancel">Cancel</button>
      <button class="primary" id="agSave">${editing ? "Save" : "Create"}</button>
    </div>
  `);
  let perm = a?.permission || "read-only";
  document.getElementById("agPermRO").addEventListener("click", () => {
    perm = "read-only";
    document.getElementById("agPermRO").classList.add("active");
    document.getElementById("agPermEdit").classList.remove("active");
  });
  document.getElementById("agPermEdit").addEventListener("click", () => {
    perm = "edit";
    document.getElementById("agPermEdit").classList.add("active");
    document.getElementById("agPermRO").classList.remove("active");
  });
  document.getElementById("agCancel").addEventListener("click", closeReviewModal);
  if (editing) {
    document.getElementById("agDelete").addEventListener("click", async () => {
      if (!confirm(`Delete agent "${a.name}"?`)) return;
      await fetch(`/api/agents/${agentId}`, { method: "DELETE" });
      closeReviewModal();
      loadSessions();
      toast("Agent deleted");
    });
  }
  document.getElementById("agSave").addEventListener("click", async () => {
    const payload = {
      name: document.getElementById("agName").value.trim(),
      emoji: document.getElementById("agEmoji").value.trim() || "🤖",
      prompt: document.getElementById("agPrompt").value.trim(),
      model: document.getElementById("agModel").value || undefined,
      permission: perm,
    };
    if (!payload.name || !payload.prompt) { toast("Name and instruction are required"); return; }
    const res = await fetch(editing ? `/api/agents/${agentId}` : "/api/agents", {
      method: editing ? "PUT" : "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const data = await res.json();
    closeReviewModal();
    if (data.ok) { loadSessions(); toast(editing ? "Agent saved" : "Agent created"); }
    else toast("Failed: " + (data.error || "unknown error"));
  });
}

const REVIEW_MODELS = [
  { value: "", label: "Inherit default" },
  { value: "sonnet", label: "Sonnet 5" },
  { value: "opus", label: "Opus 4.8" },
  { value: "haiku", label: "Haiku 4.5" },
  { value: "fable", label: "Fable 5" },
];

// Shared form-control fragments so every modal renders the same model dropdown + dangerous toggle
// (change once here, all modals update). Each takes the element id the modal reads back from.
function modelSelectHtml(id, selectedValue = "") {
  return `<select id="${id}">${REVIEW_MODELS.map(
    (m) => `<option value="${m.value}"${(selectedValue || "") === m.value ? " selected" : ""}>${m.label}</option>`
  ).join("")}</select>`;
}
function dangerousCheckboxHtml(id) {
  return `<label class="modal-checkbox dangerous-label" title="Skips all tool-call confirmation prompts in the launched session"><input type="checkbox" id="${id}" ${dangerousDefault() ? "checked" : ""} /> ⚠ Run dangerously</label>`;
}

function openGlobalSearchModal() {
  modalShell(`
    <h3>🔍 Global search</h3>
    <div style="font-size:12px; color:var(--dim);">Searches the full content of every session's conversation, not just names/tags — good for "I vaguely remember discussing X."</div>
    <div class="modal-row">
      <textarea id="globalSearchInput" class="notes-input" style="min-height:110px; font-size:13px;" placeholder="What were you working on? Describe it in as much detail as you remember..."></textarea>
    </div>
    <div class="modal-actions" style="justify-content:flex-start; align-items:center; gap:10px;">
      <select id="globalSearchDate">
        <option value="0">All time</option>
        <option value="7">Last 7 days</option>
        <option value="30">Last 30 days</option>
      </select>
      <button class="primary" id="globalSearchGo">🔍 Search</button>
    </div>
    <div id="globalSearchResults"></div>
  `, 640);
  const input = document.getElementById("globalSearchInput");
  input.focus();
  const runGlobalSearch = async () => {
    const q = input.value.trim();
    const days = Number(document.getElementById("globalSearchDate").value) || 0;
    const results = document.getElementById("globalSearchResults");
    if (q.length < 2) { results.innerHTML = '<div class="empty">Type at least 2 characters.</div>'; return; }
    results.innerHTML = '<div class="empty">Asking Claude to find the best matching session(s)… this can take up to a minute.</div>';
    const res = await fetch("/api/search/smart", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ q, days }),
    });
    const data = await res.json();
    if (data.error) { results.innerHTML = `<div class="empty">Search failed: ${escapeHtml(data.error)}</div>`; return; }
    // preserve the order Claude returned them in (best match first) — don't re-sort by recency
    const matches = (data.ids || []).map((id) => sessions.find((s) => s.id === id)).filter(Boolean);
    if (!matches.length) { results.innerHTML = '<div class="empty">No sessions genuinely match that.</div>'; return; }
    results.innerHTML = `
      <div style="font-size:11.5px; color:var(--dim); margin:8px 0 4px;">${matches.length} best match${matches.length === 1 ? "" : "es"}</div>
      <div style="display:flex; flex-direction:column; gap:6px; max-height:320px; overflow-y:auto;">
        ${matches.map((s) => `
          <div class="board-card" style="cursor:default;">
            <div class="bc-title">
              <span style="flex:1; min-width:0; overflow-wrap:anywhere;">${escapeHtml(s.meta?.name || s.meta?.description || (s.firstMessage || "").slice(0, 70) || "(untitled)")}</span>
            </div>
            <div class="bc-meta">
              <span class="chip">${escapeHtml(projectName(s.cwd))}</span>
              ${s.gitBranch ? `<span class="chip branch">${escapeHtml(s.gitBranch)}</span>` : ""}
              <span class="chip">${fmtTime(s.lastActive)}</span>
            </div>
            <div class="bc-actions">
              <button data-gsearch-action="resume" data-id="${s.id}">▶ Resume</button>
              <button data-gsearch-action="fork" data-id="${s.id}">⑂ Fork</button>
              <button data-gsearch-action="extract" data-id="${s.id}">🧠 Extract</button>
            </div>
          </div>
        `).join("")}
      </div>
    `;
    results.querySelectorAll("[data-gsearch-action]").forEach((el) => {
      el.addEventListener("click", () => {
        const { gsearchAction, id } = el.dataset;
        if (gsearchAction === "resume") { closeReviewModal(); resumeSession(id, false); }
        if (gsearchAction === "fork") { closeReviewModal(); resumeSession(id, true); }
        if (gsearchAction === "extract") { closeReviewModal(); openExtractModal(id); }
      });
    });
  };
  document.getElementById("globalSearchGo").addEventListener("click", runGlobalSearch);
  input.addEventListener("keydown", (e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) runGlobalSearch(); });
}

function modalShell(inner, width) {
  const root = document.getElementById("modalRoot");
  const widthStyle = width ? ` style="width:${width}px;"` : "";
  root.innerHTML = `<div class="modal-overlay" id="modalOverlay"><div class="modal"${widthStyle}>${inner}</div></div>`;
  document.getElementById("modalOverlay").addEventListener("click", (e) => {
    if (e.target.id === "modalOverlay") closeReviewModal();
  });
}

function closeReviewModal() {
  if (delegationPoll) { clearInterval(delegationPoll); delegationPoll = null; }
  document.getElementById("modalRoot").innerHTML = "";
}

let delegationPoll = null;
function fmtElapsed(ms) {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return `${m}m ${s % 60}s`;
}

async function openDelegationModal(id) {
  if (delegationPoll) { clearInterval(delegationPoll); delegationPoll = null; }

  const paint = async () => {
    let d;
    try {
      d = (await (await fetch(`/api/delegations/${id}`)).json()).delegation;
    } catch {
      return;
    }
    if (!d) { closeReviewModal(); toast("Delegation not found"); return; }

    const dot = d.status === "running" ? "⏳" : d.status === "done" ? "✓" : "✗";
    const elapsed = fmtElapsed((d.finishedAt || Date.now()) - d.createdAt);
    const activity = (d.progress || []);
    const activityHtml = activity.length
      ? activity.map((l) => `<div class="act-line">${escapeHtml(l)}</div>`).join("")
      : '<div class="act-line" style="color:var(--dim)">waiting for the agent to start…</div>';

    let footer = "";
    if (d.status === "running") {
      footer = `<button class="danger" id="delKill">■ Kill</button><span style="flex:1"></span><button id="delClose">Close</button>`;
    } else if (d.status === "done") {
      footer = `<a href="/delegations/${id}" target="_blank" rel="noopener" style="text-decoration:none;"><button class="primary">📄 Open full result ↗</button></a><span style="flex:1"></span><button id="delClose">Close</button>`;
    } else {
      footer = `<span style="flex:1"></span><button id="delClose">Close</button>`;
    }

    const bodyBlock =
      d.status === "done"
        ? `<div class="modal-row"><label>Result</label><div class="del-result">${escapeHtml((d.result || "").slice(0, 1200))}${(d.result || "").length > 1200 ? "…" : ""}</div></div>`
        : d.status === "error"
        ? `<div class="modal-row"><label>Error</label><div class="del-result" style="color:var(--danger)">${escapeHtml(d.error || "failed")}</div></div>`
        : "";

    modalShell(
      `<div id="delegationModal">
        <h3>${dot} ${escapeHtml(d.agentEmoji + " " + d.agentName)}</h3>
        <div style="font-size:12px; color:var(--dim);">on <b>${escapeHtml(d.sessionLabel)}</b> · ${escapeHtml(projectName(d.cwd))} · ${d.status} · ${elapsed}</div>
        <div class="modal-row">
          <label>${d.status === "running" ? "Live activity" : "Activity"} (${activity.length})</label>
          <div class="act-log">${activityHtml}</div>
        </div>
        ${bodyBlock}
        <div class="modal-actions">${footer}</div>
      </div>`,
      620
    );
    document.getElementById("delClose")?.addEventListener("click", closeReviewModal);
    document.getElementById("delKill")?.addEventListener("click", async () => {
      await fetch(`/api/delegations/${id}/cancel`, { method: "POST" });
      toast("Delegation killed");
      paint();
      loadSessions();
    });

    if (d.status !== "running" && delegationPoll) { clearInterval(delegationPoll); delegationPoll = null; }
  };

  await paint();
  // live-refresh while running; stop if the user closed the modal
  delegationPoll = setInterval(() => {
    if (!document.getElementById("delegationModal")) { clearInterval(delegationPoll); delegationPoll = null; return; }
    paint();
  }, 2000);
}

function openReviewModal(id) {
  const s = sessions.find((x) => x.id === id);
  if (!s) return;
  if (s.meta?.lastReviewId) {
    openFixModal(s.meta.lastReviewId, s.changedFiles?.length ?? 0, id);
    return;
  }
  if (!s.changedFiles || !s.changedFiles.length) {
    toast("No changed files found in this session's transcript");
    return;
  }
  modalShell(`
    <h3>🔎 Send to reviewer agent</h3>
    <div style="font-size:12px; color:var(--dim);">
      ${escapeHtml(s.meta?.name || s.meta?.description || (s.firstMessage || "").slice(0, 60))}
      — ${s.changedFiles.length} file${s.changedFiles.length === 1 ? "" : "s"} this session touched
    </div>
    <div class="file-list">${s.changedFiles.map(escapeHtml).join("<br/>")}</div>
    <div class="modal-row">
      <label for="reviewFocus">Focus (optional) — leave blank to review everything</label>
      <textarea id="reviewFocus" class="notes-input" style="min-height:80px; font-size:13px;" placeholder="e.g. review the wishlist feature only — focus on the N+1 query risk in the data-fetching layer and error handling on empty carts"></textarea>
    </div>
    <div class="modal-row">
      <label for="reviewModel">Model</label>
      ${modelSelectHtml("reviewModel")}
    </div>
    <div class="modal-actions">
      <button id="reviewCancel">Cancel</button>
      <button class="primary" id="reviewStart">▶ Start review</button>
    </div>
  `);
  document.getElementById("reviewCancel").addEventListener("click", closeReviewModal);
  document.getElementById("reviewFocus").focus();
  document.getElementById("reviewStart").addEventListener("click", async () => {
    const model = document.getElementById("reviewModel").value;
    const focus = document.getElementById("reviewFocus").value.trim();
    modalShell(`
      <h3>🔎 Reviewing…</h3>
      <div style="font-size:12.5px; color:var(--dim);">${focus ? "Reviewing: " + escapeHtml(focus) + " — " : ""}reading ${s.changedFiles.length} file${s.changedFiles.length === 1 ? "" : "s"} and writing up findings in plain English — this can take a minute or two.</div>
    `);
    try {
      const res = await fetch(`/api/sessions/${id}/review`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: model || undefined, focus: focus || undefined }),
      });
      const data = await res.json();
      if (data.ok) {
        const sess = sessions.find((x) => x.id === id);
        if (sess) sess.meta = { ...sess.meta, lastReviewId: data.reviewId };
        openFixModal(data.reviewId, data.fileCount, id);
      } else {
        closeReviewModal();
        toast("Review failed: " + (data.error || "unknown error"));
      }
    } catch (e) {
      closeReviewModal();
      toast("Review failed: " + e.message);
    }
  });
}

async function openFixModal(reviewId, fileCount, sessionId) {
  modalShell(`<h3>🔎 Loading review…</h3>`);
  const res = await fetch(`/api/reviews/${reviewId}`);
  const data = await res.json();
  if (!data.review) {
    closeReviewModal();
    toast("Couldn't load that review");
    return;
  }
  const review = data.review;
  modalShell(`
    <h3>📄 Review ready</h3>
    <div style="font-size:12.5px; color:var(--dim);">${fileCount || review.files.length} file${(fileCount || review.files.length) === 1 ? "" : "s"} reviewed, in plain English.</div>
    <a href="/reviews/${review.id}" target="_blank" rel="noopener" style="text-decoration:none;">
      <button class="primary" style="width:100%;">📄 Open full report in new tab</button>
    </a>
    <div class="modal-row">
      <label for="fixNumbers">Fix only these finding numbers (e.g. "1 2 6") — leave blank + use Fix All instead</label>
      <input type="text" id="fixNumbers" class="description-input" placeholder="1 2 6" />
    </div>
    <label class="modal-checkbox">
      <input type="checkbox" id="fixWriteTests" />
      Also write test cases for the fix and run them
    </label>
    ${dangerousCheckboxHtml("fixDangerous")}
    <div class="modal-actions">
      <button id="fixCancel">Close</button>
      <button id="fixSelected">▶ Fix selected</button>
      <button class="primary" id="fixAll">▶ Fix all</button>
    </div>
  `);
  document.getElementById("fixCancel").addEventListener("click", closeReviewModal);
  const runFix = async (selection) => {
    const writeTests = document.getElementById("fixWriteTests").checked;
    const dangerous = document.getElementById("fixDangerous").checked;
    let data2;
    try {
      const res2 = await fetch(`/api/reviews/${reviewId}/fix`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ selection, writeTests, dangerous }),
      });
      data2 = await res2.json();
    } catch (e) {
      closeReviewModal();
      toast("Failed to start fix: " + e.message);
      return;
    }
    closeReviewModal();
    if (data2.ok) {
      toast(`Fix launched in ${data2.cwd}${writeTests ? " + writing tests" : ""}`);
    } else {
      toast("Failed to start fix: " + (data2.error || "unknown error"));
    }
  };
  document.getElementById("fixAll").addEventListener("click", () => runFix("all"));
  document.getElementById("fixSelected").addEventListener("click", () => {
    const val = document.getElementById("fixNumbers").value.trim();
    if (!val) { toast("Enter finding numbers first, or use Fix All"); return; }
    runFix(val);
  });
}

function openExtractModal(id) {
  const s = sessions.find((x) => x.id === id);
  if (!s) return;
  if (s.meta?.lastContextId) {
    openContextResultModal(s.meta.lastContextId, id);
    return;
  }
  modalShell(`
    <h3>🧠 Extract context from this session</h3>
    <div style="font-size:12px; color:var(--dim);">
      ${escapeHtml(s.meta?.name || s.meta?.description || (s.firstMessage || "").slice(0, 60))}
    </div>
    <div style="font-size:12.5px; color:var(--dim);">Condenses this session's task, decisions, files touched, and next steps into a short briefing — so you can start a fresh session without carrying the full history's token weight.</div>
    <div class="modal-row">
      <label for="extractModel">Model</label>
      ${modelSelectHtml("extractModel")}
    </div>
    <div class="modal-actions">
      <button id="extractCancel">Cancel</button>
      <button class="primary" id="extractStart">▶ Extract context</button>
    </div>
  `);
  document.getElementById("extractCancel").addEventListener("click", closeReviewModal);
  document.getElementById("extractStart").addEventListener("click", async () => {
    const model = document.getElementById("extractModel").value;
    modalShell(`
      <h3>🧠 Extracting context…</h3>
      <div style="font-size:12.5px; color:var(--dim);">Reading the full transcript and writing a condensed briefing — this can take a minute or two.</div>
    `);
    try {
      const res = await fetch(`/api/sessions/${id}/extract-context`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: model || undefined }),
      });
      const data = await res.json();
      if (data.ok) {
        const sess = sessions.find((x) => x.id === id);
        if (sess) sess.meta = { ...sess.meta, lastContextId: data.contextId };
        toast("Context extracted");
        openContextResultModal(data.contextId, id);
      } else {
        closeReviewModal();
        toast("Extraction failed: " + (data.error || "unknown error"));
      }
    } catch (e) {
      closeReviewModal();
      toast("Extraction failed: " + e.message);
    }
  });
}

async function openContextResultModal(contextId, sessionId) {
  modalShell(`<h3>🧠 Loading context…</h3>`);
  const res = await fetch(`/api/contexts/${contextId}`);
  const data = await res.json();
  if (!data.context) {
    closeReviewModal();
    toast("Couldn't load that context");
    return;
  }
  modalShell(`
    <h3>🧠 Context extracted</h3>
    <a href="/contexts/${contextId}" target="_blank" rel="noopener" style="text-decoration:none;">
      <button class="primary" style="width:100%;">📄 Open context points in new tab</button>
    </a>
    <div class="modal-row">
      <label for="ctxName">Name the new session (optional)</label>
      <input type="text" id="ctxName" placeholder="e.g. wishlist-skeleton-continued" />
    </div>
    <div class="modal-row">
      <label for="ctxModel">Model</label>
      ${modelSelectHtml("ctxModel")}
    </div>
    ${dangerousCheckboxHtml("ctxDangerous")}
    <div class="modal-actions">
      <button id="ctxCancel">Close</button>
      <button id="ctxReExtract">↻ Re-extract</button>
      <button class="primary" id="ctxStart">▶ Start new session from this</button>
    </div>
  `);
  document.getElementById("ctxCancel").addEventListener("click", closeReviewModal);
  document.getElementById("ctxReExtract").addEventListener("click", () => {
    const sess = sessions.find((x) => x.id === sessionId);
    if (sess) sess.meta = { ...sess.meta, lastContextId: undefined };
    openExtractModal(sessionId);
  });
  document.getElementById("ctxStart").addEventListener("click", async () => {
    const name = document.getElementById("ctxName").value.trim();
    const model = document.getElementById("ctxModel").value;
    const dangerous = document.getElementById("ctxDangerous").checked;
    let data2;
    try {
      const res2 = await fetch(`/api/contexts/${contextId}/start`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: name || undefined, model: model || undefined, dangerous }),
      });
      data2 = await res2.json();
    } catch (e) {
      closeReviewModal();
      toast("Failed to start new session: " + e.message);
      return;
    }
    closeReviewModal();
    if (data2.ok) {
      toast(`New session${name ? ' "' + name + '"' : ""} launched in ${data2.cwd}`);
    } else {
      toast("Failed to start new session: " + (data2.error || "unknown error"));
    }
  });
}

function openColumnTaskModal(colId) {
  const col = boardColumns.find((c) => c.id === colId);
  const projectOptions = [...new Set(sessions.map((s) => s.cwd))].sort();
  modalShell(`
    <h3>⚡ New task → ${escapeHtml(col?.title || colId)}</h3>
    <label class="modal-checkbox" title="A ticket is just a note to yourself — no Claude session is started" style="color:var(--ticket-ink); font-weight:600;">
      <input type="checkbox" id="colIsTicket" /> 🎫 Just a ticket (a note to do later — doesn't start a session)
    </label>
    <div class="modal-row">
      <label for="colTaskName" id="colNameLabel">Session name (optional)</label>
      <input type="text" id="colTaskName" placeholder="e.g. wishlist-skeleton" />
    </div>
    <div class="modal-row">
      <label for="colTaskDesc" id="colDescLabel">Task</label>
      <textarea id="colTaskDesc" class="notes-input" style="min-height:70px" placeholder="Describe the task..."></textarea>
    </div>
    <div class="session-only">
      <div class="modal-row">
        <label for="colTaskProject">Project</label>
        <select id="colTaskProject">${projectOptions.map((p) => `<option value="${escapeAttr(p)}">${escapeHtml(p)}</option>`).join("")}</select>
      </div>
      <div class="modal-row">
        <label for="colTaskModel">Model</label>
        ${modelSelectHtml("colTaskModel")}
      </div>
      <div class="mode-toggle">
        <button id="colModeSolo" class="active" data-mode="solo" title="One interactive session, nothing automatic after it">Solo</button>
        <button id="colModeReview" data-mode="implement-review" title="Runs the task, then automatically chains a reviewer pass on the diff">Implement → Review</button>
        <button id="colModeResearch" data-mode="research" title="Read-only: searches the web, reads docs/MCPs, reports a plan — never edits files">🔎 Research</button>
      </div>
      ${dangerousCheckboxHtml("colTaskDangerous")}
    </div>
    <div class="modal-actions">
      <button id="colTaskCancel">Cancel</button>
      <button class="primary" id="colTaskStart">▶ Launch in new terminal</button>
    </div>
  `);
  const isTicketBox = document.getElementById("colIsTicket");
  const syncTicketMode = () => {
    const t = isTicketBox.checked;
    document.querySelectorAll(".session-only").forEach((el) => (el.style.display = t ? "none" : ""));
    document.getElementById("colNameLabel").textContent = t ? "Ticket title" : "Session name (optional)";
    document.getElementById("colDescLabel").textContent = t ? "Notes (optional)" : "Task";
    document.getElementById("colTaskStart").textContent = t ? "🎫 Create ticket" : "▶ Launch in new terminal";
  };
  isTicketBox.addEventListener("change", syncTicketMode);
  let colMode = "solo";
  const colModeIds = { solo: "colModeSolo", "implement-review": "colModeReview", research: "colModeResearch" };
  Object.entries(colModeIds).forEach(([modeVal, elId]) => {
    document.getElementById(elId).addEventListener("click", () => {
      colMode = modeVal;
      Object.values(colModeIds).forEach((otherId) => document.getElementById(otherId).classList.toggle("active", otherId === elId));
    });
  });
  document.getElementById("colTaskCancel").addEventListener("click", closeReviewModal);
  document.getElementById("colTaskStart").addEventListener("click", async () => {
    const name = document.getElementById("colTaskName").value.trim();
    const desc = document.getElementById("colTaskDesc").value.trim();

    if (isTicketBox.checked) {
      const title = name || desc;
      if (!title) { toast("Give the ticket a title"); return; }
      const res = await fetch("/api/tickets", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title, notes: name ? desc : undefined, board: colId }),
      });
      const data = await res.json();
      closeReviewModal();
      if (data.ok) { toast("Ticket created"); loadSessions(); }
      else toast("Failed to create ticket: " + (data.error || "unknown error"));
      return;
    }

    const cwd = document.getElementById("colTaskProject").value;
    const model = document.getElementById("colTaskModel").value;
    const dangerous = document.getElementById("colTaskDangerous").checked;
    const data = await launchTask({ cwd, task: desc, name, model, mode: colMode, dangerous });
    if (data?.ok) {
      closeReviewModal();
      if (data.sessionId) patchMeta(data.sessionId, { board: colId }); // drop the new session straight into the column it was launched from
    }
  });
}

function convertTicketToSession(id) {
  const t = sessions.find((x) => x.id === id);
  if (!t) return;
  const projectOptions = [...new Set(sessions.filter((s) => s.cwd).map((s) => s.cwd))].sort();
  modalShell(`
    <h3>▶ Start session from ticket</h3>
    <div style="font-size:12px; color:var(--dim);">The ticket is removed once the session launches.</div>
    <div class="modal-row">
      <label for="ctSessName">Session name (optional)</label>
      <input type="text" id="ctSessName" value="${escapeAttr(t.meta?.name || "")}" />
    </div>
    <div class="modal-row">
      <label for="ctSessProject">Project</label>
      <select id="ctSessProject">${projectOptions.map((p) => `<option value="${escapeAttr(p)}">${escapeHtml(p)}</option>`).join("")}</select>
    </div>
    <div class="modal-row">
      <label for="ctSessTask">Task</label>
      <textarea id="ctSessTask" class="notes-input" style="min-height:70px">${escapeHtml([t.meta?.name, t.meta?.notes].filter(Boolean).join(" — "))}</textarea>
    </div>
    <div class="modal-row">
      <label for="ctSessModel">Model</label>
      ${modelSelectHtml("ctSessModel")}
    </div>
    ${dangerousCheckboxHtml("ctSessDangerous")}
    <div class="modal-actions">
      <button id="ctSessCancel">Cancel</button>
      <button class="primary" id="ctSessGo">▶ Launch in new terminal</button>
    </div>
  `);
  document.getElementById("ctSessCancel").addEventListener("click", closeReviewModal);
  document.getElementById("ctSessGo").addEventListener("click", async () => {
    const cwd = document.getElementById("ctSessProject").value;
    const task = document.getElementById("ctSessTask").value.trim();
    const name = document.getElementById("ctSessName").value.trim();
    const model = document.getElementById("ctSessModel").value;
    const dangerous = document.getElementById("ctSessDangerous").checked;
    const data = await launchTask({ cwd, task, name, model, mode: "solo", dangerous });
    if (data?.ok) {
      const board = t.meta?.board;
      await fetch(`/api/tickets/${id}`, { method: "DELETE" }); // ticket becomes a real session
      closeReviewModal();
      if (data.sessionId && board) patchMeta(data.sessionId, { board });
      loadSessions();
    }
  });
}

function toggleDetails(id) {
  if (expandedCards.has(id)) expandedCards.delete(id);
  else expandedCards.add(id);
  render();
}

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, c => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;" }[c]));
}
function escapeAttr(s) { return escapeHtml(s); }

function ctxBadgeHtml(s) {
  if (s.contextPct == null) return "";
  const level = s.contextPct >= 80 ? "red" : s.contextPct >= 50 ? "yellow" : "green";
  return `
    <span class="ctx-badge ctx-${level}" title="~${s.contextTokens.toLocaleString()} tokens in context (~${s.contextPct}% of a ${((s.contextWindow || 200000) / 1000).toFixed(0)}k window)">
      <span class="bar"><span style="width:${s.contextPct}%"></span></span>
      ${s.contextPct}%
    </span>
  `;
}

function cardHtml(s) {
  if (s.isTicket) {
    const done = s.meta?.status === "done";
    return `
      <div class="card ticket-card ${done ? "ticket-done" : ""}">
        <div class="card-top">
          <span class="ticket-tag" style="margin-top:3px;">TICKET</span>
          <div class="card-title-wrap">
            <div class="card-title" style="${done ? "text-decoration:line-through; opacity:0.6;" : ""}">
              <span style="flex:1;">${escapeHtml(s.meta?.name || "(untitled ticket)")}</span>
              <span class="rename-pencil" data-action="rename" data-id="${s.id}" title="Rename">✎</span>
            </div>
            ${s.meta?.notes ? `<div class="card-msg">${escapeHtml(s.meta.notes)}</div>` : ""}
          </div>
        </div>
        <div class="card-actions">
          <button data-action="ticket-done" data-id="${s.id}">${done ? "↩ Reopen" : "✓ Done"}</button>
          <button data-action="ticket-convert" data-id="${s.id}">▶ Start session</button>
          <span class="spacer"></span>
          <button class="danger" data-action="delete" data-id="${s.id}">🗑 Delete</button>
        </div>
      </div>
    `;
  }
  const isLive = !!s.running;
  const open = expandedCards.has(s.id);
  const description = s.meta?.description;
  const isAuto = s.meta?.descriptionSource === "auto";
  const summarizing = summarizingIds.has(s.id);
  return `
    <div class="card ${s.meta?.pinned ? "pinned" : ""}">
      <div class="card-top">
        <div class="dot ${isLive ? "live" : "idle"}" title="${isLive ? "process running (pid " + s.running.pid + ")" : "not running"}"></div>
        <div class="card-title-wrap">
          <div class="card-title">
            <input data-name-edit="${s.id}" value="${escapeAttr(s.meta?.name || "")}" placeholder="${escapeAttr(s.firstMessage ? s.firstMessage.slice(0, 60) : "untitled")}" />
            <span class="rename-pencil" data-action="rename-focus" data-id="${s.id}" title="Rename">✎</span>
          </div>
          <div class="description-line ${description ? "" : "unset"}">
            <input class="description-input" data-description-edit="${s.id}"
              value="${escapeAttr(description || "")}"
              placeholder="${escapeAttr(s.firstMessage ? "no description yet — click ✨ to auto-generate, or type your own: \"" + s.firstMessage.slice(0, 50) + "...\"" : "no description yet")}" />
            ${isAuto ? '<span class="auto-tag">auto</span>' : ""}
            <button class="summarize-btn ${summarizing ? "loading" : ""}" data-action="summarize" data-id="${s.id}" title="Auto-generate a short description from this session's messages">${summarizing ? "…" : "✨"}</button>
          </div>
          <div class="meta-row">
            ${s.gitBranch ? `<span class="chip branch">${escapeHtml(s.gitBranch)}</span>` : ""}
            <span class="chip">${fmtTime(s.lastActive)}</span>
            <span class="chip">${s.messageCount} msgs</span>
            <span class="chip">${(s.sizeBytes / 1024).toFixed(0)} KB</span>
            ${ctxBadgeHtml(s)}
            ${isLive ? `<span class="chip" style="color:var(--ok)">running · pid ${s.running.pid}</span>` : ""}
          </div>
        </div>
      </div>
      <div class="card-actions">
        <button class="primary" data-action="resume" data-id="${s.id}">▶ Resume</button>
        <button data-action="fork" data-id="${s.id}">⑂ Fork</button>
        <button data-action="copy" data-id="${s.id}">⧉ Copy cmd</button>
        <button data-action="pin" data-id="${s.id}">${s.meta?.pinned ? "★ Pinned" : "☆ Pin"}</button>
        <button data-action="review" data-id="${s.id}" title="Send this session's changed files to a reviewer agent">🔎 Review</button>
        <button data-action="extract" data-id="${s.id}" title="Condense this session into a briefing for a fresh session">🧠 Extract</button>
        <button data-action="toggleDetails" data-id="${s.id}">${open ? "▲ Less" : "▾ Tags/notes"}</button>
        <span class="spacer"></span>
        <button class="danger" data-action="delete" data-id="${s.id}">🗑 Delete</button>
      </div>
      <div class="collapsible-details ${open ? "open" : ""}">
        <input class="tags-input" data-tags-edit="${s.id}" placeholder="tags, comma, separated" value="${escapeAttr((s.meta?.tags || []).join(", "))}" />
        <textarea class="notes-input" data-notes-edit="${s.id}" placeholder="notes...">${escapeHtml(s.meta?.notes || "")}</textarea>
        <div style="font-size:11px; color:var(--dim); font-family: ui-monospace, monospace;">${s.id}</div>
      </div>
    </div>
  `;
}

document.getElementById("search").addEventListener("input", (e) => {
  render();
  clearTimeout(contentSearchTimer);
  contentSearchTimer = setTimeout(() => fetchContentMatches(e.target.value), 350);
});
document.getElementById("sort").value = localStorage.getItem("sortMode") || "recent";
document.getElementById("sort").addEventListener("change", (e) => {
  localStorage.setItem("sortMode", e.target.value);
  render();
});
document.getElementById("filterDate").addEventListener("change", render);
document.getElementById("filterProject").addEventListener("change", render);
const globalDangerousBox = document.getElementById("globalDangerous");
globalDangerousBox.checked = dangerousDefault();
globalDangerousBox.addEventListener("change", (e) => {
  localStorage.setItem("globalDangerous", e.target.checked ? "1" : "0");
});
document.getElementById("refreshBtn").addEventListener("click", loadSessions);
document.getElementById("globalSearchBtn").addEventListener("click", openGlobalSearchModal);

document.addEventListener("keydown", (e) => {
  const tag = document.activeElement?.tagName;
  const typing = tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
  if (e.key === "Escape") {
    if (document.getElementById("modalRoot").innerHTML.trim()) { closeReviewModal(); return; }
    if (typing) document.activeElement.blur();
    return;
  }
  if (typing) return;
  if (e.key === "/") {
    e.preventDefault();
    document.getElementById("search").focus();
  } else if (e.key === "n") {
    e.preventDefault();
    openColumnTaskModal(boardColumns[0]?.id); // same New Task modal the column "+" opens
  }
});

document.getElementById("viewList").addEventListener("click", () => setView("list"));
document.getElementById("viewBoard").addEventListener("click", () => setView("board"));
function setView(v) {
  currentView = v;
  localStorage.setItem("currentView", v);
  document.getElementById("viewList").classList.toggle("active", v === "list");
  document.getElementById("viewBoard").classList.toggle("active", v === "board");
  document.getElementById("sort").style.display = v === "board" ? "none" : "";
  document.getElementById("app").classList.toggle("board-mode", v === "board");
  render();
}
setView(currentView);

// ---------- project filter dropdown ----------
// Launching now lives entirely in the per-column "+" New Task modal; this dropdown scopes the
// visible board/list to one project's sessions.
async function loadProjects() {
  const res = await fetch("/api/projects");
  const data = await res.json();
  const sel = document.getElementById("filterProject");
  const current = sel.value;
  sel.innerHTML =
    '<option value="">All projects</option>' +
    data.projects.map((p) => `<option value="${escapeAttr(p)}">${escapeHtml(p)}</option>`).join("");
  if (current && data.projects.includes(current)) sel.value = current; // preserve selection across refreshes
}

async function launchTask({ cwd, task, name, model, mode, dangerous = true }) {
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

loadSessions();
loadProjects();
setInterval(loadSessions, 15000); // keep "running" dots + new sessions fresh
