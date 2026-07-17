const API = "";
let sessions = [];
let agents = [];
let delegations = [];
let todos = [];
let currentTab = localStorage.getItem("currentTab") || "sessions";
// global "run dangerously" default — drives resume/fork directly and pre-checks per-launch modals.
// defaults ON (matches the tool's dangerous-by-default behavior) unless the user turned it off.
function dangerousDefault() {
  return localStorage.getItem("globalDangerous") !== "0";
}
let collapsedProjects = new Set(JSON.parse(localStorage.getItem("collapsedProjects") || "[]"));
let expandedCards = new Set();
let summarizingIds = new Set();
let currentView = "board";
const DEFAULT_COLUMNS = [
  { id: "todo", title: "All sessions" },
  { id: "in-progress", title: "In Progress" },
  { id: "priority", title: "Priority" },
  { id: "research", title: "Research" },
  { id: "done", title: "Done" },
];
const OLD_DEFAULT_ORDER = ["todo", "priority", "research", "in-progress", "done"];
// Board columns are stored server-side (data/board.json). Start with defaults for the first
// synchronous render; loadSessions replaces with server's copy (migrating localStorage on first run).
function migrateColumns(cols) {
  if (cols.map((c) => c.id).join(",") === OLD_DEFAULT_ORDER.join(",")) return DEFAULT_COLUMNS.slice();
  const todo = cols.find((c) => c.id === "todo");
  if (todo && todo.title === "To Do") todo.title = "All sessions";
  return cols;
}
let boardColumns = DEFAULT_COLUMNS.slice();
async function saveBoardColumns() {
  await fetch("/api/board", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ columns: boardColumns }),
  });
}

// ---------- per-project boards: "Group by project" browses INTO a separate, independently
// persisted board per project instead of ever touching the main board's columns ----------
// The URL is the source of truth for which view is showing (not localStorage), so a hard
// reload or a shared link lands back on the same page: "/" = main board, "/projects" = the
// project picker, "/projects/<encoded-cwd>" = a drilled-in project's own board. The server
// (src/routes.ts) serves index.html for all three so a direct/reloaded request works too.
function boardModeFromLocation() {
  const path = location.pathname;
  if (path === "/projects") return { mode: "projects", cwd: null };
  const m = path.match(/^\/projects\/(.+)$/);
  if (m) return { mode: "project", cwd: decodeURIComponent(m[1]) };
  return { mode: "main", cwd: null };
}
const initialBoardState = boardModeFromLocation();
let boardMode = initialBoardState.mode; // "main" | "projects" | "project"
let activeProjectCwd = initialBoardState.cwd;
let projectBoards = {};           // Record<cwd, BoardColumn[]> — mirrors server's project-boards.json
// BoardColumn[] for whichever project is currently drilled into. Seeded synchronously with
// DEFAULT_COLUMNS (mirroring how `boardColumns` itself defaults synchronously) so a hard reload
// straight into /projects/<cwd> has something non-null to render with before loadSessions()'s
// fetch resolves and replaces this with the project's real saved columns (or these same defaults).
let currentProjectColumns = boardMode === "project" ? DEFAULT_COLUMNS.slice() : null;

async function saveProjectBoardColumns(cwd) {
  await fetch("/api/project-board", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ cwd, columns: currentProjectColumns }),
  });
}

// ctx objects let renderBoardView work against either the main board or a per-project board
// without duplicating its ~200 lines of column-management/drag-and-drop code. `cols` is a
// getter/setter so a reassignment inside renderBoardView (e.g. removing a column) writes
// through to the right global instead of just rebinding a local parameter.
function mainBoardCtx() {
  return {
    get cols() { return boardColumns; },
    set cols(v) { boardColumns = v; },
    save: saveBoardColumns,
  };
}
function projectBoardCtx(cwd) {
  return {
    get cols() { return currentProjectColumns; },
    set cols(v) { currentProjectColumns = v; projectBoards[cwd] = v; },
    save: () => saveProjectBoardColumns(cwd),
  };
}

function pathForBoardMode(mode, cwd) {
  if (mode === "projects") return "/projects";
  if (mode === "project") return "/projects/" + encodeURIComponent(cwd);
  return "/";
}

function setBoardMode(mode, { skipPush = false } = {}) {
  boardMode = mode;
  if (mode !== "project") activeProjectCwd = null;
  if (!skipPush) history.pushState({ boardMode, activeProjectCwd }, "", pathForBoardMode(boardMode, activeProjectCwd));
  render();
}

async function enterProjectBoard(cwd) {
  activeProjectCwd = cwd;
  const isFirstVisit = !projectBoards[cwd];
  if (isFirstVisit) projectBoards[cwd] = DEFAULT_COLUMNS.slice(); // same defaults as the main board
  currentProjectColumns = projectBoards[cwd];
  if (isFirstVisit) await saveProjectBoardColumns(cwd);
  setBoardMode("project");
}

// browser back/forward — re-derive state from the URL bar rather than trusting popstate's
// event.state (works even if the user typed/edited the URL directly, not just navigated via it)
window.addEventListener("popstate", () => {
  const { mode, cwd } = boardModeFromLocation();
  boardMode = mode;
  activeProjectCwd = cwd;
  if (mode === "project" && cwd) {
    currentProjectColumns = projectBoards[cwd] || DEFAULT_COLUMNS.slice();
  }
  render();
});


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
    startedSessionId: t.startedSessionId,
    meta: { name: t.title, notes: t.notes, board: t.board, status: t.done ? "done" : undefined },
  }));
  sessions = [...data.sessions, ...tickets];
  agents = data.agents || [];
  delegations = data.delegations || [];
  todos = data.todos || [];

  // session board columns: server is source of truth; migrate localStorage on first run
  if (Array.isArray(data.board) && data.board.length) {
    boardColumns = migrateColumns(data.board);
  } else {
    const legacy = JSON.parse(localStorage.getItem("boardColumns") || "null");
    boardColumns = migrateColumns(legacy && legacy.length ? legacy : DEFAULT_COLUMNS.slice());
    saveBoardColumns();
  }

  projectBoards = (data.projectBoards && typeof data.projectBoards === "object") ? data.projectBoards : {};
  if (boardMode === "project" && activeProjectCwd) {
    currentProjectColumns = projectBoards[activeProjectCwd] || DEFAULT_COLUMNS.slice();
  }

  render();
  if (currentTab === "todos") renderTodoBoard();
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
  document.getElementById("groupByProjectBtn")?.classList.toggle("active", boardMode !== "main");

  if (boardMode === "projects") {
    renderProjectPicker(q);
    return;
  }
  if (boardMode === "project") {
    const filtered = sessions.filter((s) => s.cwd === activeProjectCwd && matchesSearch(s, q));
    document.getElementById("statLine").textContent = `${filtered.length} session${filtered.length === 1 ? "" : "s"} shown`;
    renderBoardView(filtered, projectBoardCtx(activeProjectCwd), projectBreadcrumbHtml());
    return;
  }

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
    renderBoardView(filtered, mainBoardCtx());
    return;
  }
  renderListView(filtered, sortMode);
}

// ---------- per-project board browsing: a picker listing every project, and a breadcrumb
// header shown atop a drilled-in project's board ----------

function projectBreadcrumbHtml() {
  return `
    <div class="board-breadcrumb">
      <button data-back-to-projects>← All projects</button>
      <button data-back-to-main>← Back to board</button>
      <h2>${escapeHtml(projectName(activeProjectCwd))}</h2>
    </div>
  `;
}

// "Group by project" — one column per project, populated with that project's real session
// cards (running-first, then most recent), computed fresh on every render rather than ever
// being written back to the main board.json — so the main board's own columns are never
// touched. Clicking a column's header drills into that project's own independent board.
function renderProjectPicker(q) {
  const app = document.getElementById("app");
  const byCwd = new Map();
  for (const s of sessions) {
    if (s.isTicket || !s.cwd) continue;
    if (q && !matchesSearch(s, q)) continue;
    if (!byCwd.has(s.cwd)) byCwd.set(s.cwd, []);
    byCwd.get(s.cwd).push(s);
  }
  const byRecency = (a, b) => (b.running ? 1 : 0) - (a.running ? 1 : 0) || b.lastActive - a.lastActive;
  const entries = [...byCwd.entries()].sort((a, b) => projectName(a[0]).localeCompare(projectName(b[0])));
  for (const [, list] of entries) list.sort(byRecency);

  document.getElementById("statLine").textContent = `${entries.length} project${entries.length === 1 ? "" : "s"}`;

  app.innerHTML = `
    <div class="board-breadcrumb">
      <button data-back-to-main>← Back to board</button>
    </div>
    <div class="board">
      ${entries.length ? entries.map(([cwd, list]) => `
        <div class="board-col">
          <div class="board-col-header project-col-header" data-project-cwd="${escapeAttr(cwd)}" title="Open ${escapeAttr(projectName(cwd))}'s own board">
            <span style="flex:1; min-width:0; overflow-wrap:anywhere;">${escapeHtml(projectName(cwd))}</span>
            <span class="board-count">${list.length}</span>
          </div>
          <div class="board-col-body">
            ${list.map(boardCardHtml).join("") || '<div class="empty" style="padding:16px 0;">No sessions</div>'}
          </div>
        </div>
      `).join("") : '<div class="empty">No sessions with a project yet.</div>'}
    </div>
  `;

  app.querySelector("[data-back-to-main]").addEventListener("click", () => setBoardMode("main"));
  app.querySelectorAll("[data-project-cwd]").forEach((el) => {
    el.addEventListener("click", () => enterProjectBoard(el.dataset.projectCwd));
  });

  wireBoardCards(app);
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
  const summarizing = summarizingIds.has(s.id);
  return `
    <div class="board-card" draggable="true" data-card-id="${s.id}">
      <div class="bc-title">
        <span class="dot ${isLive ? "live" : "idle"}" style="margin-top:0"></span>
        <span style="flex:1; min-width:0; overflow-wrap:anywhere;">${escapeHtml(title)}</span>
        <div class="bc-menu-wrap">
          <button class="bc-menu-btn" data-menu-toggle="${s.id}" title="Options">⋮</button>
          <div class="bc-dropdown" id="menu-${s.id}">
            <button data-action="resume" data-id="${s.id}">▶ Resume</button>
            <button data-action="fork" data-id="${s.id}">⑂ Fork</button>
            <button data-action="review" data-id="${s.id}">🔎 Review</button>
            <button data-action="extract" data-id="${s.id}">🧠 Extract</button>
            <button data-action="rename" data-id="${s.id}">✎ Rename</button>
            <button data-action="editDesc" data-id="${s.id}">✐ Edit description</button>
            <button class="danger" data-action="delete" data-id="${s.id}">🗑 Delete</button>
          </div>
        </div>
      </div>
      <div class="bc-desc ${desc ? "" : "no-desc"}">
        <span class="bc-desc-text">${escapeHtml(desc || "no description")}</span>
        ${desc && !summarizing ? "" : `<button class="summarize-btn ${summarizing ? "loading" : ""}" data-action="summarize" data-id="${s.id}" title="Auto-generate description">${summarizing ? "" : "✦"}</button>`}
      </div>
      <div class="bc-meta">
        <span class="chip">${escapeHtml(projectName(s.cwd))}</span>
        ${s.gitBranch ? `<span class="chip branch">${escapeHtml(s.gitBranch)}</span>` : ""}
        <span class="bc-time" title="${new Date(s.lastActive).toLocaleString()}">${timeAgo(s.lastActive)}</span>
      </div>
      ${ctxBadgeFullHtml(s)}
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
        <div class="bc-menu-wrap">
          <button class="bc-menu-btn" data-menu-toggle="${s.id}" title="Options">⋮</button>
          <div class="bc-dropdown" id="menu-${s.id}">
            ${s.startedSessionId
              ? `<button data-action="resume" data-id="${s.startedSessionId}">▶ Resume</button>`
              : `<button data-action="ticket-convert" data-id="${s.id}">▶ Start session</button>`}
            <button data-action="rename" data-id="${s.id}">✎ Rename</button>
            <button class="danger" data-action="delete" data-id="${s.id}">🗑 Delete</button>
          </div>
        </div>
      </div>
      ${notes ? `<div class="bc-desc"><span style="flex:1; overflow-wrap:anywhere;">${escapeHtml(notes)}</span></div>` : ""}
      <div class="bc-meta">
        <button class="ticket-done-btn ${done ? "is-done" : ""}" data-action="ticket-done" data-id="${s.id}">${done ? "↩ Reopen" : "✓ Done"}</button>
      </div>
    </div>
  `;
}

// Card action wiring shared by renderBoardView (main/per-project boards) and the "Group by
// project" columns view — click actions, double-click-to-resume, and the three-dot menu.
function wireBoardCards(app) {
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
      if (action === "editDesc") {
        const next = prompt("Edit description:", s?.meta?.description || "");
        if (next !== null) patchMeta(id, { description: next.trim() || undefined, descriptionSource: next.trim() ? "manual" : undefined });
      }
    });
  });

  // double-click on board card to resume session
  app.querySelectorAll(".board-card[data-card-id]").forEach((card) => {
    card.addEventListener("dblclick", (e) => {
      if (e.target.closest(".bc-menu-wrap") || e.target.closest("button")) return;
      const id = card.dataset.cardId;
      const s = sessions.find((x) => x.id === id);
      if (s?.isTicket) return;
      resumeSession(id, false);
    });
  });

  // three-dot menu toggle
  app.querySelectorAll("[data-menu-toggle]").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const id = btn.dataset.menuToggle;
      const dropdown = document.getElementById("menu-" + id);
      const wasOpen = dropdown.classList.contains("open");
      document.querySelectorAll(".bc-dropdown.open").forEach((d) => d.classList.remove("open"));
      if (!wasOpen) {
        const rect = btn.getBoundingClientRect();
        const spaceBelow = window.innerHeight - rect.bottom;
        dropdown.style.left = "";
        dropdown.style.right = (window.innerWidth - rect.right) + "px";
        if (spaceBelow < 200) {
          dropdown.style.top = "";
          dropdown.style.bottom = (window.innerHeight - rect.top) + "px";
        } else {
          dropdown.style.top = rect.bottom + 4 + "px";
          dropdown.style.bottom = "";
        }
        dropdown.classList.add("open");
      }
    });
  });
}

function renderBoardView(filtered, ctx, breadcrumbHtml = "") {
  const app = document.getElementById("app");
  const byColumn = new Map(ctx.cols.map((c) => [c.id, []]));
  for (const s of filtered) {
    const col = s.meta?.board && byColumn.has(s.meta.board) ? s.meta.board : ctx.cols[0]?.id;
    if (col && byColumn.has(col)) byColumn.get(col).push(s);
  }
  // running-first, then most recent — same rule as list view so a session you just touched floats up
  const byRecency = (a, b) => (b.running ? 1 : 0) - (a.running ? 1 : 0) || b.lastActive - a.lastActive;
  for (const arr of byColumn.values()) arr.sort(byRecency);

  app.innerHTML = `
    ${breadcrumbHtml}
    ${agentsDockHtml()}
    <div class="board">
      ${ctx.cols.map((c) => `
        <div class="board-col" data-col-id="${c.id}">
          <div class="board-col-header" draggable="true" data-col-drag="${c.id}" title="Drag to reorder columns">
            <span class="drag-handle">⠿</span>
            <span>${escapeHtml(c.title)}</span>
            <span class="board-count">${(byColumn.get(c.id) || []).length}</span>
            <div class="col-header-actions" style="margin-left:auto; display:flex; align-items:center; gap:2px;">
            <span class="col-add-btn" data-add-col-task="${c.id}" title="New task">+</span>
            <div class="bc-menu-wrap">
              <button class="bc-menu-btn" data-col-menu-toggle="${c.id}" title="Column options">⋮</button>
              <div class="bc-dropdown" id="col-menu-${c.id}">
                <button data-rename-col="${c.id}">✎ Rename</button>
                <button class="danger" data-remove-col="${c.id}">✕ Remove</button>
              </div>
            </div>
            </div>
          </div>
          <div class="board-col-body" data-col-drop="${c.id}">
            ${(byColumn.get(c.id) || []).map(boardCardHtml).join("") || '<div class="empty" style="padding:16px 0;">Drop here</div>'}
          </div>
        </div>
      `).join("")}
      <button class="add-col-btn" id="addColBtn">+ Add column</button>
    </div>
  `;

  if (breadcrumbHtml) {
    app.querySelector("[data-back-to-projects]")?.addEventListener("click", () => setBoardMode("projects"));
    app.querySelector("[data-back-to-main]")?.addEventListener("click", () => setBoardMode("main"));
  }

  wireBoardCards(app);

  // column three-dot menu toggle
  app.querySelectorAll("[data-col-menu-toggle]").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const id = btn.dataset.colMenuToggle;
      const dropdown = document.getElementById("col-menu-" + id);
      const wasOpen = dropdown.classList.contains("open");
      document.querySelectorAll(".bc-dropdown.open").forEach((d) => d.classList.remove("open"));
      if (!wasOpen) {
        const rect = btn.getBoundingClientRect();
        dropdown.style.left = "";
        dropdown.style.right = (window.innerWidth - rect.right) + "px";
        dropdown.style.top = rect.bottom + 4 + "px";
        dropdown.style.bottom = "";
        dropdown.classList.add("open");
      }
    });
  });

  app.querySelectorAll("[data-add-col-task]").forEach((el) => {
    el.addEventListener("click", (e) => {
      e.stopPropagation();
      openColumnTaskModal(el.dataset.addColTask, ctx);
    });
  });

  app.querySelectorAll("[data-rename-col]").forEach((el) => {
    el.addEventListener("click", (e) => {
      e.stopPropagation();
      const id = el.dataset.renameCol;
      const col = ctx.cols.find((c) => c.id === id);
      const next = prompt("Rename column:", col?.title || "");
      if (next === null || !next.trim()) return;
      col.title = next.trim();
      ctx.save();
      render();
    });
  });

  app.querySelectorAll("[data-remove-col]").forEach((el) => {
    el.addEventListener("click", (e) => {
      e.stopPropagation();
      const id = el.dataset.removeCol;
      const col = ctx.cols.find((c) => c.id === id);
      if (!confirm(`Remove column "${col?.title}"? Sessions in it move back to "${ctx.cols[0].title}".`)) return;
      ctx.cols = ctx.cols.filter((c) => c.id !== id);
      ctx.save();
      render();
    });
  });

  document.getElementById("addColBtn")?.addEventListener("click", () => {
    const title = prompt("New column name:");
    if (!title || !title.trim()) return;
    const base = title.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "") || "col";
    let id = base;
    let n = 2;
    while (ctx.cols.some((c) => c.id === id)) { id = `${base}-${n++}`; } // ids can collide with a renamed column's stable id even when titles differ
    ctx.cols.push({ id, title: title.trim() });
    ctx.save();
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
        const fromIdx = ctx.cols.findIndex((c) => c.id === draggedId);
        const toIdx = ctx.cols.findIndex((c) => c.id === colId);
        if (fromIdx === -1 || toIdx === -1) return;
        const [moved] = ctx.cols.splice(fromIdx, 1);
        ctx.cols.splice(toIdx, 0, moved);
        ctx.save();
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

// function agentsDockHtml() {
//   const collapsed = localStorage.getItem("agentsDockCollapsed") === "1";
//   const recent = delegations.slice(0, 8);
//   const jobChip = (d) => {
//     const icon = d.status === "done" ? "✓" : d.status === "error" ? "✗" : "⏳";
//     const cls = d.status === "done" ? "job-done" : d.status === "error" ? "job-error" : "job-running";
//     return `<span class="job-chip ${cls}" data-open-delegation="${d.id}" title="${escapeAttr(d.agentName + " → " + d.sessionLabel)} — click for details">
//       ${icon} ${escapeHtml(d.agentEmoji)} ${escapeHtml(d.sessionLabel.slice(0, 24))}</span>`;
//   };
//   return `
//     <div class="agents-dock ${collapsed ? "collapsed" : ""}" id="agentsDock">
//       <div class="dock-row">
//         <span class="dock-label" id="agentsDockToggle" title="Collapse/expand">AGENTS ${collapsed ? "▸" : "▾"}</span>
//         ${agents
//           .map(
//             (a) => `<div class="agent-tile" data-agent-drop="${a.id}" data-agent-edit="${a.id}" title="${escapeAttr(a.prompt.slice(0, 120))} — drop a session to delegate; click to edit">
//               <span>${escapeHtml(a.emoji)}</span> <span>${escapeHtml(a.name)}</span>
//               <span class="agent-perm ${a.permission === "edit" ? "perm-edit" : "perm-ro"}">${a.permission === "edit" ? "✎" : "👁"}</span>
//             </div>`
//           )
//           .join("")}
//         <div class="agent-tile agent-new" id="agentNewTile" title="Create a new agent">＋ New agent</div>
//       </div>
//       <div class="dock-row dock-jobs">
//         <span class="dock-label">JOBS</span>
//         ${recent.length ? recent.map(jobChip).join("") : '<span class="dock-empty">no delegations yet — drop a session on an agent</span>'}
//         <a class="dock-all" href="/delegations" target="_blank" rel="noopener">all ↗</a>
//       </div>
//     </div>
//   `;
// }
function agentsDockHtml() { return ''; }

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

function openColumnTaskModal(colId, ctx) {
  const col = ctx.cols.find((c) => c.id === colId);
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
    document.getElementById("colDescLabel").textContent = t ? "Task (optional)" : "Task";
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
    <div style="font-size:12px; color:var(--dim);">The ticket stays on the board and switches to a "Resume" button once the session launches.</div>
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
      closeReviewModal();
      if (data.sessionId) await patchMeta(id, { startedSessionId: data.sessionId }); // ticket keeps its board slot, now resumes the launched session
      loadSessions();
    }
  });
}

function toggleDetails(id) {
  if (expandedCards.has(id)) expandedCards.delete(id);
  else expandedCards.add(id);
  render();
}

function timeAgo(ts) {
  const diff = Date.now() - ts;
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  return `${months}mo ago`;
}

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, c => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;" }[c]));
}
function escapeAttr(s) { return escapeHtml(s); }

function ctxBadgeFullHtml(s) {
  if (s.contextPct == null) return "";
  const level = s.contextPct >= 80 ? "red" : s.contextPct >= 50 ? "yellow" : "green";
  return `
    <div class="ctx-bar-full ctx-${level}" title="~${s.contextTokens.toLocaleString()} tokens (~${s.contextPct}% of ${((s.contextWindow || 200000) / 1000).toFixed(0)}k)">
      <div class="ctx-track"><div class="ctx-fill" style="width:${s.contextPct}%"></div></div>
      <span class="ctx-label">${s.contextPct}%</span>
    </div>`;
}

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
          ${s.startedSessionId
            ? `<button class="primary" data-action="resume" data-id="${s.startedSessionId}">▶ Resume</button>`
            : `<button data-action="ticket-convert" data-id="${s.id}">▶ Start session</button>`}
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
        <button data-action="review" data-id="${s.id}" title="Send this session's changed files to a reviewer agent">🔎 Review</button>
        <button data-action="extract" data-id="${s.id}" title="Condense this session into a briefing for a fresh session">🧠 Extract</button>
        <button data-action="pin" data-id="${s.id}">${s.meta?.pinned ? "★ Pinned" : "☆ Pin"}</button>
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
  if (currentTab === "todos") { renderTodoBoard(); return; }
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
document.getElementById("groupByProjectBtn").addEventListener("click", () => setBoardMode("projects"));
document.getElementById("globalSearchBtn").addEventListener("click", openGlobalSearchModal);

// ---------- dark / light mode toggle ----------
// `data-theme` on <html> (set inline in index.html's <head>, before first paint) overrides the
// CSS's default OS-driven `prefers-color-scheme`; absence of the attribute means "follow the OS".
function currentTheme() {
  const override = document.documentElement.getAttribute("data-theme");
  if (override) return override;
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}
function updateThemeIcon() {
  const btn = document.getElementById("themeToggleBtn");
  if (!btn) return;
  const dark = currentTheme() === "dark";
  btn.textContent = dark ? "☀️" : "🌙";
  btn.title = dark ? "Switch to light mode" : "Switch to dark mode";
}
const themeSound = new Audio("/assets/theme-click.mp3");
themeSound.preload = "auto";
function playThemeSound() {
  themeSound.currentTime = 0;
  themeSound.play().catch(() => {}); // ignore autoplay-policy rejections — never block the toggle
}
document.getElementById("themeToggleBtn").addEventListener("click", () => {
  const next = currentTheme() === "dark" ? "light" : "dark";
  document.documentElement.setAttribute("data-theme", next);
  localStorage.setItem("theme", next);
  updateThemeIcon();
  playThemeSound();
});
// if the user hasn't explicitly chosen a theme, keep the icon in sync with OS changes
window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
  if (!localStorage.getItem("theme")) updateThemeIcon();
});
updateThemeIcon();

// close card menus on outside click
document.addEventListener("click", () => {
  document.querySelectorAll(".bc-dropdown.open").forEach((d) => d.classList.remove("open"));
});

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
    if (boardMode !== "main") return; // global shortcut only targets the main board, not whatever project/picker is showing
    e.preventDefault();
    openColumnTaskModal(boardColumns[0]?.id, mainBoardCtx()); // same New Task modal the column "+" opens
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

// ---------- todo board ----------

function todoCardHtml(t) {
  const statusCls = t.status === "done" ? "s-done" : t.status === "in-progress" ? "s-in-progress" : "s-todo";
  const assignedSession = t.assignedSessionId ? sessions.find((s) => s.id === t.assignedSessionId) : null;
  const sessionLabel = assignedSession ? (assignedSession.meta?.name || assignedSession.meta?.description || assignedSession.firstMessage || "").slice(0, 30) : "";
  return `
    <div class="todo-card board-card" draggable="true" data-todo-id="${t.id}">
      <div class="tc-title">
        <span style="flex:1; min-width:0; overflow-wrap:anywhere;">${escapeHtml(t.title)}</span>
        <div class="bc-menu-wrap">
          <button class="bc-menu-btn" data-todo-menu="${t.id}" title="Options">⋮</button>
          <div class="bc-dropdown" id="todo-menu-${t.id}">
            <button data-todo-action="edit" data-todo-id="${t.id}">✎ Edit</button>
            <button data-todo-action="assign" data-todo-id="${t.id}">▶ Assign to Claude</button>
            ${t.status !== "done" ? `<button data-todo-action="done" data-todo-id="${t.id}">✓ Mark done</button>` : `<button data-todo-action="reopen" data-todo-id="${t.id}">↺ Reopen</button>`}
            <button class="danger" data-todo-action="delete" data-todo-id="${t.id}">🗑 Delete</button>
          </div>
        </div>
      </div>
      ${t.description ? `<div class="tc-desc">${escapeHtml(t.description)}</div>` : ""}
      <div class="tc-footer">
        <span class="tc-status ${statusCls}">${t.status || "todo"}</span>
        ${sessionLabel ? `<span class="tc-session">→ ${escapeHtml(sessionLabel)}</span>` : ""}
      </div>
    </div>
  `;
}

function renderTodoBoard() {
  const todoApp = document.getElementById("todoApp");
  todoApp.classList.add("board-mode");
  const q = document.getElementById("search").value.trim().toLowerCase();
  const filtered = q ? todos.filter((t) => (t.title + " " + (t.description || "")).toLowerCase().includes(q)) : todos;

  const byCol = new Map(boardColumns.map((c) => [c.id, []]));
  for (const t of filtered) {
    const col = t.board && byCol.has(t.board) ? t.board : boardColumns[0].id;
    byCol.get(col).push(t);
  }
  // sort by most recently updated first
  for (const arr of byCol.values()) arr.sort((a, b) => b.updatedAt - a.updatedAt);

  todoApp.innerHTML = `
    <div class="board">
      ${boardColumns.map((c) => `
        <div class="board-col" data-todo-col-id="${c.id}">
          <div class="board-col-header" draggable="true" data-todo-col-drag="${c.id}">
            <span class="drag-handle">⠿</span>
            <span>${escapeHtml(c.title)}</span>
            <span class="board-count">${(byCol.get(c.id) || []).length}</span>
            <div class="bc-menu-wrap" style="margin-left:auto;">
              <button class="bc-menu-btn" data-todo-col-menu="${c.id}" title="Column options">⋮</button>
              <div class="bc-dropdown" id="todo-col-menu-${c.id}">
                <button data-todo-col-action="add" data-col="${c.id}">+ New todo</button>
                <button data-todo-col-action="rename" data-col="${c.id}">✎ Rename</button>
                <button class="danger" data-todo-col-action="remove" data-col="${c.id}">✕ Remove</button>
              </div>
            </div>
          </div>
          <div class="board-col-body" data-todo-col-drop="${c.id}">
            ${(byCol.get(c.id) || []).map(todoCardHtml).join("") || '<div class="empty" style="padding:16px 0;">Drop here</div>'}
          </div>
        </div>
      `).join("")}
      <button class="add-col-btn" id="addTodoColBtn">+ Add column</button>
    </div>
  `;

  wireTodoBoard(todoApp);
}

function wireTodoBoard(app) {
  // card three-dot menu
  app.querySelectorAll("[data-todo-menu]").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const id = btn.dataset.todoMenu;
      const dropdown = document.getElementById("todo-menu-" + id);
      const wasOpen = dropdown.classList.contains("open");
      document.querySelectorAll(".bc-dropdown.open").forEach((d) => d.classList.remove("open"));
      if (!wasOpen) {
        const rect = btn.getBoundingClientRect();
        const spaceBelow = window.innerHeight - rect.bottom;
        dropdown.style.right = (window.innerWidth - rect.right) + "px";
        dropdown.style.left = "";
        if (spaceBelow < 200) { dropdown.style.top = ""; dropdown.style.bottom = (window.innerHeight - rect.top) + "px"; }
        else { dropdown.style.top = rect.bottom + 4 + "px"; dropdown.style.bottom = ""; }
        dropdown.classList.add("open");
      }
    });
  });

  // card actions
  app.querySelectorAll("[data-todo-action]").forEach((el) => {
    el.addEventListener("click", async (e) => {
      e.stopPropagation();
      const action = el.dataset.todoAction;
      const id = el.dataset.todoId;
      const t = todos.find((x) => x.id === id);
      if (action === "edit") openTodoEditModal(id);
      if (action === "assign") openTodoAssignModal(id);
      if (action === "done") await patchTodo(id, { status: "done" });
      if (action === "reopen") await patchTodo(id, { status: "todo" });
      if (action === "delete") {
        if (!confirm(`Delete "${t?.title}"?`)) return;
        await fetch(`/api/todos/${id}`, { method: "DELETE" });
        todos = todos.filter((x) => x.id !== id);
        renderTodoBoard();
        toast("Todo deleted");
      }
    });
  });

  // column three-dot menu
  app.querySelectorAll("[data-todo-col-menu]").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const id = btn.dataset.todoColMenu;
      const dropdown = document.getElementById("todo-col-menu-" + id);
      const wasOpen = dropdown.classList.contains("open");
      document.querySelectorAll(".bc-dropdown.open").forEach((d) => d.classList.remove("open"));
      if (!wasOpen) {
        const rect = btn.getBoundingClientRect();
        dropdown.style.right = (window.innerWidth - rect.right) + "px";
        dropdown.style.left = "";
        dropdown.style.top = rect.bottom + 4 + "px";
        dropdown.style.bottom = "";
        dropdown.classList.add("open");
      }
    });
  });

  // column actions
  app.querySelectorAll("[data-todo-col-action]").forEach((el) => {
    el.addEventListener("click", (e) => {
      e.stopPropagation();
      const action = el.dataset.todoColAction;
      const colId = el.dataset.col;
      if (action === "add") openTodoCreateModal(colId);
      if (action === "rename") {
        const col = boardColumns.find((c) => c.id === colId);
        const next = prompt("Rename column:", col?.title || "");
        if (next && next.trim()) { col.title = next.trim(); saveBoardColumns(); renderTodoBoard(); }
      }
      if (action === "remove") {
        const col = boardColumns.find((c) => c.id === colId);
        if (boardColumns.length <= 1) { toast("Need at least one column"); return; }
        if (!confirm(`Remove column "${col?.title}"?`)) return;
        // move todos to first column
        todos.forEach((t) => { if (t.board === colId) patchTodo(t.id, { board: boardColumns[0].id }); });
        boardColumns = boardColumns.filter((c) => c.id !== colId);
        saveBoardColumns();
        renderTodoBoard();
      }
    });
  });

  // add column
  document.getElementById("addTodoColBtn")?.addEventListener("click", () => {
    const title = prompt("New column name:");
    if (!title?.trim()) return;
    const id = title.trim().toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9-]/g, "");
    if (boardColumns.some((c) => c.id === id)) { toast("Column already exists"); return; }
    boardColumns.push({ id: id || crypto.randomUUID(), title: title.trim() });
    saveBoardColumns();
    renderTodoBoard();
  });

  // drag & drop for todo cards
  app.querySelectorAll("[data-todo-id]").forEach((card) => {
    if (!card.classList.contains("todo-card")) return;
    card.addEventListener("dragstart", (e) => {
      e.dataTransfer.setData("text/todo-id", card.dataset.todoId);
      card.classList.add("dragging");
    });
    card.addEventListener("dragend", () => card.classList.remove("dragging"));
  });

  app.querySelectorAll("[data-todo-col-drop]").forEach((zone) => {
    zone.addEventListener("dragover", (e) => { e.preventDefault(); zone.closest(".board-col").classList.add("dragover"); });
    zone.addEventListener("dragleave", () => zone.closest(".board-col").classList.remove("dragover"));
    zone.addEventListener("drop", async (e) => {
      e.preventDefault();
      zone.closest(".board-col").classList.remove("dragover");
      const todoId = e.dataTransfer.getData("text/todo-id");
      if (!todoId) return;
      const colId = zone.dataset.todoColDrop;
      await patchTodo(todoId, { board: colId });
    });
  });

  // drag & drop for column reorder
  app.querySelectorAll("[data-todo-col-drag]").forEach((hdr) => {
    hdr.addEventListener("dragstart", (e) => {
      e.dataTransfer.setData("text/todo-col-drag", hdr.dataset.todoColDrag);
      hdr.closest(".board-col").classList.add("dragging");
    });
    hdr.addEventListener("dragend", () => hdr.closest(".board-col").classList.remove("dragging"));
  });
  app.querySelectorAll("[data-todo-col-id]").forEach((col) => {
    col.addEventListener("dragover", (e) => { if (e.dataTransfer.types.includes("text/todo-col-drag")) { e.preventDefault(); col.classList.add("dragover"); } });
    col.addEventListener("dragleave", () => col.classList.remove("dragover"));
    col.addEventListener("drop", (e) => {
      col.classList.remove("dragover");
      const fromId = e.dataTransfer.getData("text/todo-col-drag");
      if (!fromId) return;
      const toId = col.dataset.todoColId;
      if (fromId === toId) return;
      const fromIdx = boardColumns.findIndex((c) => c.id === fromId);
      const toIdx = boardColumns.findIndex((c) => c.id === toId);
      const [moved] = boardColumns.splice(fromIdx, 1);
      boardColumns.splice(toIdx, 0, moved);
      saveBoardColumns();
      renderTodoBoard();
    });
  });
}

async function patchTodo(id, patch) {
  const t = todos.find((x) => x.id === id);
  if (t) Object.assign(t, patch);
  renderTodoBoard();
  await fetch(`/api/todos/${id}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(patch),
  });
}

function openTodoCreateModal(colId) {
  modalShell(`
    <h3>+ New Todo</h3>
    <div class="modal-row">
      <label for="todoTitle">Title</label>
      <input type="text" id="todoTitle" placeholder="What needs to be done?" />
    </div>
    <div class="modal-row">
      <label for="todoDesc">Description (optional)</label>
      <textarea id="todoDesc" class="notes-input" style="min-height:80px" placeholder="Add details, context, acceptance criteria..."></textarea>
    </div>
    <div class="modal-actions">
      <button id="todoCreateCancel">Cancel</button>
      <button class="primary" id="todoCreateSave">Create</button>
    </div>
  `);
  document.getElementById("todoCreateCancel").addEventListener("click", closeReviewModal);
  document.getElementById("todoCreateSave").addEventListener("click", async () => {
    const title = document.getElementById("todoTitle").value.trim();
    if (!title) { toast("Give it a title"); return; }
    const description = document.getElementById("todoDesc").value.trim();
    const res = await fetch("/api/todos", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title, description: description || undefined, board: colId }),
    });
    const data = await res.json();
    if (data.ok) {
      todos.push(data.todo);
      closeReviewModal();
      renderTodoBoard();
      toast("Todo created");
    } else {
      toast("Failed: " + (data.error || "unknown"));
    }
  });
}

function openTodoEditModal(id) {
  const t = todos.find((x) => x.id === id);
  if (!t) return;
  modalShell(`
    <h3>Edit Todo</h3>
    <div class="modal-row">
      <label for="todoEditTitle">Title</label>
      <input type="text" id="todoEditTitle" value="${escapeAttr(t.title)}" />
    </div>
    <div class="modal-row">
      <label for="todoEditDesc">Description</label>
      <textarea id="todoEditDesc" class="notes-input" style="min-height:80px">${escapeHtml(t.description || "")}</textarea>
    </div>
    <div class="modal-row">
      <label for="todoEditStatus">Status</label>
      <select id="todoEditStatus">
        <option value="todo" ${t.status === "todo" ? "selected" : ""}>To Do</option>
        <option value="in-progress" ${t.status === "in-progress" ? "selected" : ""}>In Progress</option>
        <option value="done" ${t.status === "done" ? "selected" : ""}>Done</option>
      </select>
    </div>
    <div class="modal-actions">
      <button id="todoEditCancel">Cancel</button>
      <button class="primary" id="todoEditSave">Save</button>
    </div>
  `);
  document.getElementById("todoEditCancel").addEventListener("click", closeReviewModal);
  document.getElementById("todoEditSave").addEventListener("click", async () => {
    const title = document.getElementById("todoEditTitle").value.trim();
    if (!title) { toast("Title is required"); return; }
    await patchTodo(id, {
      title,
      description: document.getElementById("todoEditDesc").value.trim() || undefined,
      status: document.getElementById("todoEditStatus").value,
    });
    closeReviewModal();
    toast("Todo updated");
  });
}

function openTodoAssignModal(id) {
  const t = todos.find((x) => x.id === id);
  if (!t) return;
  // auto-detect project from column's cwd
  const col = t.board ? boardColumns.find((c) => c.id === t.board) : null;
  const colCwd = col?.cwd || "";
  const projectOptions = [...new Set(sessions.filter((s) => s.cwd && !s.isTicket).map((s) => s.cwd))].sort();
  const recentSessions = sessions
    .filter((s) => !s.isTicket)
    .sort((a, b) => b.lastActive - a.lastActive)
    .slice(0, 20);

  modalShell(`
    <h3>▶ Assign to Claude</h3>
    <div style="font-size:12px; color:var(--dim); margin-bottom:4px;">${escapeHtml(t.title)}</div>
    <div class="mode-toggle" style="max-width:300px;">
      <button id="assignNew" class="active">New session</button>
      <button id="assignExisting">Existing session</button>
    </div>
    <div id="assignNewFields">
      <div class="modal-row">
        <label for="assignProject">Project</label>
        <select id="assignProject">${projectOptions.map((p) => `<option value="${escapeAttr(p)}" ${p === colCwd ? "selected" : ""}>${escapeHtml(p)}</option>`).join("")}</select>
      </div>
      <div class="modal-row">
        <label for="assignModel">Model</label>
        ${modelSelectHtml("assignModel")}
      </div>
      ${dangerousCheckboxHtml("assignDangerous")}
    </div>
    <div id="assignExistingFields" style="display:none;">
      <div class="modal-row">
        <label for="assignSession">Pick a session</label>
        <select id="assignSession">
          ${recentSessions.map((s) => `<option value="${s.id}">${escapeHtml((s.meta?.name || s.firstMessage || s.id).slice(0, 60))}</option>`).join("")}
        </select>
      </div>
    </div>
    <div class="modal-actions">
      <button id="assignCancel">Cancel</button>
      <button class="primary" id="assignGo">▶ Assign</button>
    </div>
  `, 480);

  let mode = "new";
  document.getElementById("assignNew").addEventListener("click", () => {
    mode = "new";
    document.getElementById("assignNew").classList.add("active");
    document.getElementById("assignExisting").classList.remove("active");
    document.getElementById("assignNewFields").style.display = "";
    document.getElementById("assignExistingFields").style.display = "none";
  });
  document.getElementById("assignExisting").addEventListener("click", () => {
    mode = "existing";
    document.getElementById("assignExisting").classList.add("active");
    document.getElementById("assignNew").classList.remove("active");
    document.getElementById("assignNewFields").style.display = "none";
    document.getElementById("assignExistingFields").style.display = "";
  });
  document.getElementById("assignCancel").addEventListener("click", closeReviewModal);
  document.getElementById("assignGo").addEventListener("click", async () => {
    let body;
    if (mode === "new") {
      const cwd = document.getElementById("assignProject").value;
      const model = document.getElementById("assignModel").value;
      const dangerous = document.getElementById("assignDangerous").checked;
      if (!cwd) { toast("Pick a project"); return; }
      body = { cwd, model: model || undefined, dangerous };
    } else {
      const sessionId = document.getElementById("assignSession").value;
      if (!sessionId) { toast("Pick a session"); return; }
      body = { sessionId, dangerous: dangerousDefault() };
    }
    const res = await fetch(`/api/todos/${id}/assign`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (data.ok) {
      const t2 = todos.find((x) => x.id === id);
      if (t2) { t2.assignedSessionId = data.sessionId; t2.status = "in-progress"; }
      closeReviewModal();
      renderTodoBoard();
      toast("Assigned to Claude — session launched");
      loadSessions();
    } else {
      toast("Failed: " + (data.error || "unknown"));
    }
  });
}

// ---------- tab switching ----------

function setTab(tab) {
  currentTab = tab;
  localStorage.setItem("currentTab", tab);
  document.getElementById("tabSessions").classList.toggle("active", tab === "sessions");
  document.getElementById("tabTodos").classList.toggle("active", tab === "todos");
  const app = document.getElementById("app");
  const todoApp = document.getElementById("todoApp");
  if (tab === "sessions") {
    app.style.display = "";
    todoApp.style.display = "none";
    render();
  } else {
    app.style.display = "none";
    todoApp.style.display = "";
    renderTodoBoard();
  }
}

document.getElementById("tabSessions").addEventListener("click", () => setTab("sessions"));
document.getElementById("tabTodos").addEventListener("click", () => setTab("todos"));

loadSessions();
loadProjects();
setInterval(loadSessions, 15000);
// Refresh immediately whenever you come back to this tab/window — otherwise a card's embedded
// session id can be up to 15s stale. That staleness is exactly what let a real bug through: open a
// session, /clear it (server-side reconciliation swaps which id owns that card), close the
// terminal, then immediately re-click the SAME still-stale card before the next scheduled poll —
// resuming the OLD pre-clear id instead of the one that actually now lives there. Since closing a
// terminal and clicking back into the browser is exactly a focus/visibility change, catch it here.
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") loadSessions();
});
window.addEventListener("focus", loadSessions);
// apply initial tab
if (currentTab === "todos") setTimeout(() => setTab("todos"), 0);
