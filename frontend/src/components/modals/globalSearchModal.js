import { sessions } from "../../state.js";
import { modalShell, closeReviewModal } from "../../ui/modalShell.js";
import { escapeHtml, fmtTime, projectName } from "../../ui/format.js";
import { resumeSession } from "../../api/sessionsApi.js";
import { openExtractModal } from "./extractModal.js";

export function openGlobalSearchModal() {
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
