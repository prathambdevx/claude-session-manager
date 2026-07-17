// One session/ticket card as it appears in the flat list view (components/listView/renderListView.js)
// — richer/wider than boardCard.js's kanban card, with inline-editable name/description/tags/notes.
import { expandedCards, summarizingIds } from "../state.js";
import { escapeHtml, escapeAttr, fmtTime } from "../ui/format.js";
import { ctxBadgeHtml } from "../ui/contextBadge.js";

export function cardHtml(s) {
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
