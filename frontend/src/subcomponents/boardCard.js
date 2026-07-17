// One session/ticket card as it appears on the kanban board (main board, a per-project board,
// or a "Group by project" column) — as opposed to subcomponents/listCard.js's list-view card.
import { summarizingIds, quickPrompts } from "../state.js";
import { escapeHtml, timeAgo, projectName } from "../ui/format.js";
import { ctxBadgeFullHtml } from "../ui/contextBadge.js";

// Quick Prompt's job chip — persists on the card until clicked (never auto-hides), showing the
// backend job's real running/done/error state. There's no true percent-complete for an open-ended
// agentic task, so "running" gets an indeterminate sliding bar rather than a fabricated number;
// done/error get a full, color-matched bar. The step label is the latest line of the job's own
// live activity log (same field the backend already streams for Delegations).
function jobChipHtml(s) {
  const j = quickPrompts.find((x) => x.sessionId === s.id);
  if (!j) return "";
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
            <button data-action="extract" data-id="${s.id}">🧠 Extract</button>
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
      ${jobChipHtml(s)}
    </div>
  `;
}

export function ticketCardHtml(s) {
  const title = s.meta?.name || "(untitled ticket)";
  const notes = s.meta?.notes;
  const done = s.meta?.status === "done";
  return `
    <div class="board-card ticket-card ${done ? "ticket-done" : ""}" draggable="true" data-card-id="${s.id}">
      <div class="bc-title">
        <span class="ticket-tag">TICKET</span>
        <span style="flex:1; min-width:0; overflow-wrap:anywhere; ${done ? "text-decoration:line-through; opacity:0.6;" : ""}">${escapeHtml(title)}</span>
        <span class="rename-pencil" data-action="rename" data-id="${s.id}" title="Rename">✎</span>
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
    </div>
  `;
}
