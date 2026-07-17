// "Quick Prompt" — hand a session a task without opening a terminal yourself. The backend decides
// how to deliver it (types straight into the session's terminal if one's already open, otherwise
// resumes it in the background — see api/quickPromptsApi.js and backend/src/routes/quickPrompts.ts).
// The chip row is learned from what you actually send TO THIS SESSION (session.meta.promptHistory),
// not a shared/global list or hand-authored presets — whatever you repeat most rises to the top.
import { sessions } from "../../state.js";
import { modalShell, closeReviewModal } from "../../ui/modalShell.js";
import { escapeHtml, escapeAttr } from "../../ui/format.js";
import { patchMeta, loadSessions } from "../../api/sessionsApi.js";
import { sendQuickPrompt } from "../../api/quickPromptsApi.js";

function topPromptChips(s) {
  return (s.meta?.promptHistory || []).slice().sort((a, b) => b.count - a.count).slice(0, 5);
}

function nextPromptHistory(s, text) {
  const history = (s.meta?.promptHistory || []).slice();
  const existing = history.find((p) => p.text === text);
  if (existing) existing.count++;
  else history.push({ text, count: 1 });
  return history;
}

export function openQuickPromptModal(id) {
  const s = sessions.find((x) => x.id === id);
  if (!s) return;
  const chips = topPromptChips(s);
  const chipLabel = (t) => (t.length > 34 ? t.slice(0, 34) + "…" : t);
  const title = s.meta?.name || (s.firstMessage ? s.firstMessage.slice(0, 40) : id.slice(0, 8));

  modalShell(`
    <h3>⚡ Quick prompt → ${escapeHtml(title)}</h3>
    <div class="qp-hint">Delivered straight into this session — its own open terminal if one's running, otherwise resumed in the background. No new terminal window either way.</div>
    <div class="qp-presets">
      ${chips.length
        ? chips.map((p, i) => `
          <span class="qp-chip">
            <button type="button" class="qp-chip-fill" data-fill="${i}" title="${escapeAttr(p.text)}">${escapeHtml(chipLabel(p.text))}${p.count > 1 ? ` <span class="qp-chip-n">×${p.count}</span>` : ""}</button>
            <button type="button" class="qp-chip-del" data-del="${i}" title="Remove this prompt">✕</button>
          </span>
        `).join("")
        : '<span class="qp-presets-empty">Prompts you send will show up here to reuse next time</span>'}
    </div>
    <div class="modal-row">
      <label>Prompt</label>
      <textarea id="qpText" class="notes-input qp-text" placeholder="e.g. Point the local web server at the UAT BFF instead of prod"></textarea>
    </div>
    <div class="modal-actions">
      <button id="qpCancel">Cancel</button>
      <button class="primary" id="qpGo">⚡ Send</button>
    </div>
  `, 460);

  const textEl = document.getElementById("qpText");
  textEl.focus();

  document.querySelectorAll("[data-fill]").forEach((btn) => {
    btn.addEventListener("click", () => {
      textEl.value = chips[Number(btn.dataset.fill)].text;
      textEl.focus();
    });
  });

  document.querySelectorAll("[data-del]").forEach((btn) => {
    btn.addEventListener("click", async (e) => {
      e.stopPropagation();
      const removed = chips[Number(btn.dataset.del)];
      const nextHistory = (s.meta?.promptHistory || []).filter((p) => p.text !== removed.text);
      await patchMeta(id, { promptHistory: nextHistory });
      closeReviewModal();
      openQuickPromptModal(id); // reopen fresh so the chip row reflects the removal
    });
  });

  document.getElementById("qpCancel").addEventListener("click", closeReviewModal);
  document.getElementById("qpGo").addEventListener("click", async () => {
    const text = textEl.value.trim();
    if (!text) return;
    closeReviewModal();
    await patchMeta(id, { promptHistory: nextPromptHistory(s, text) });
    await sendQuickPrompt(id, text);
    loadSessions();
  });
}
