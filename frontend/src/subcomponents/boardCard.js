// One session/ticket card as it appears on the kanban board (main board, a per-project board,
// or a "Group by project" column).
import { summarizingIds, quickPrompts, sessions } from "../state.js";
import { escapeHtml, timeAgo, projectName } from "../ui/format.js";
import { ctxBadgeFullHtml } from "../ui/contextBadge.js";

// Quick Prompt's job chip — picks this session's MOST RECENT job; steps aside for
// workingChipHtml/doneChipHtml if that job already finished but the session is active again.
function jobChipHtml(s) {
  const j = quickPrompts
    .filter((x) => x.sessionId === s.id)
    .sort((a, b) => b.createdAt - a.createdAt)[0];
  if (!j) return "";
  if (j.status !== "running" && s.activelyWorking) return "";
  const cls = j.status === "error" ? "job-error" : j.status === "done" ? "job-done" : "job-running";
  const icon = j.status === "error" ? '<span class="jc-icon">⚠</span>'
    : j.status === "done" ? '<span class="jc-icon">✓</span>'
    : '<span class="job-spin"></span>';
  const label = j.prompt.length > 50 ? j.prompt.slice(0, 50) + "…" : j.prompt;
  const step = j.status === "done" ? "Done" : j.status === "error" ? (j.error || "Failed")
    : (j.progress?.[j.progress.length - 1] || "Working…");
  return `
    <div class="job-chip ${cls}" data-action="quickjob-dismiss" data-id="${j.id}" title="${escapeHtml(j.prompt)} — click to dismiss">
      <div class="jc-row">${icon}<span class="jc-text">${escapeHtml(label)}</span></div>
      <div class="jc-step">${escapeHtml(step)}</div>
      <div class="jc-track"><div class="jc-fill"></div></div>
    </div>
  `;
}

// Reuses Quick Prompt's .job-chip/.job-running for any actively-working session — s.activelyWorking
// checks a recent transcript write too, since Claude Code's own "busy" status can get stuck stale.
function workingChipHtml(s) {
  if (!s.activelyWorking) return "";
  return `
    <div class="job-chip job-running">
      <div class="jc-row"><span class="job-spin"></span><span class="jc-text">${escapeHtml(s.lastActivity || "Working…")}</span></div>
      <div class="jc-track"><div class="jc-fill"></div></div>
    </div>
  `;
}

// Shows the same "done" chip as Quick Prompt jobs, inferred from the transcript: activityLine's 💭
// marker means the last message was plain text, no further tool call queued. Bounded to a recency
// window so it doesn't stay stale.
const DONE_CHIP_WINDOW_MS = 5 * 60 * 1000;
function doneChipHtml(s) {
  if (s.activelyWorking || !s.lastActivity?.startsWith("💭")) return "";
  if (Date.now() - s.lastActive > DONE_CHIP_WINDOW_MS) return "";
  const msg = s.lastActivity.slice(2).trim();
  return `
    <div class="job-chip job-done">
      <div class="jc-row"><span class="jc-icon">✓</span><span class="jc-text">Done: "${escapeHtml(msg)}"</span></div>
      <div class="jc-track"><div class="jc-fill"></div></div>
    </div>
  `;
}

export function boardCardHtml(s) {
  if (s.isTicket) return ticketCardHtml(s);
  const title = s.meta?.name || (s.firstMessage ? s.firstMessage.slice(0, 50) : "(untitled)");
  const desc = s.meta?.description;
  const isLive = !!s.running;
  const summarizing = summarizingIds.has(s.id);
  return `
    <div class="board-card" draggable="true" data-card-id="${s.id}">
      <div class="bc-title">
        <span class="dot ${isLive ? "live" : "idle"}" style="margin-top:0"></span>
        <span style="min-width:0; overflow-wrap:anywhere;">${escapeHtml(title)}</span>
        <span class="rename-pencil" data-action="rename" data-id="${s.id}" title="Rename">✎</span>
        <span class="bc-title-spacer"></span>
        <span class="quick-prompt-btn" data-action="quickprompt" data-id="${s.id}" title="Quick prompt — run something in the background, no terminal">⚡</span>
        <div class="bc-menu-wrap">
          <button class="bc-menu-btn" data-menu-toggle="${s.id}" title="Options">⋮</button>
          <div class="bc-dropdown" id="menu-${s.id}">
            <button data-action="resume" data-id="${s.id}">▶ Resume</button>
            <button data-action="fork" data-id="${s.id}">⑂ Fork</button>
            <button data-action="review" data-id="${s.id}">🔎 Review</button>
            <!-- Extract is currently unused/hidden — see components/modals/extractModal.js -->
            <button data-action="editDesc" data-id="${s.id}">✐ Edit description</button>
            <button class="danger" data-action="closeTerminal" data-id="${s.id}">✕ Close terminal</button>
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
      ${jobChipHtml(s) || workingChipHtml(s) || doneChipHtml(s)}
    </div>
  `;
}

export function ticketCardHtml(s) {
  const title = s.meta?.name || "(untitled ticket)";
  const notes = s.meta?.notes;
  const done = s.meta?.status === "done";
  const startedSession = s.startedSessionId ? sessions.find((x) => x.id === s.startedSessionId) : null;
  return `
    <div class="board-card ticket-card ${done ? "ticket-done" : ""}" draggable="true" data-card-id="${s.id}">
      <div class="bc-title">
        <span class="ticket-tag">TICKET</span>
        <span style="min-width:0; overflow-wrap:anywhere; ${done ? "text-decoration:line-through; opacity:0.6;" : ""}">${escapeHtml(title)}</span>
        <span class="rename-pencil" data-action="rename" data-id="${s.id}" title="Rename">✎</span>
        <span class="bc-title-spacer"></span>
        ${s.startedSessionId ? `<span class="quick-prompt-btn" data-action="quickprompt" data-id="${s.startedSessionId}" title="Quick prompt — run something in the background, no terminal">⚡</span>` : ""}
        <div class="bc-menu-wrap">
          <button class="bc-menu-btn" data-menu-toggle="${s.id}" title="Options">⋮</button>
          <div class="bc-dropdown" id="menu-${s.id}">
            ${s.startedSessionId
              ? `<button data-action="resume" data-id="${s.startedSessionId}">▶ Resume</button>`
              : `<button data-action="ticket-convert" data-id="${s.id}">▶ Start session</button>`}
            <button class="danger" data-action="delete" data-id="${s.id}">🗑 Delete</button>
          </div>
        </div>
      </div>
      ${notes ? `<div class="bc-desc"><span style="flex:1; overflow-wrap:anywhere;">${escapeHtml(notes)}</span></div>` : ""}
      <div class="bc-meta">
        <button class="ticket-done-btn ${done ? "is-done" : ""}" data-action="ticket-done" data-id="${s.id}">${done ? "↩ Reopen" : "✓ Done"}</button>
      </div>
      ${startedSession ? (jobChipHtml(startedSession) || workingChipHtml(startedSession) || doneChipHtml(startedSession)) : ""}
    </div>
  `;
}
