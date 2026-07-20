// Quick Prompt: delivers straight into an open terminal or resumes in the background (see
// api/quickPromptsApi.js). Chip row is ranked from this session's own promptHistory, not a shared
// preset list.
import { sessions } from "../../state.js";
import { modalShell, closeModal } from "../../ui/modalShell.js";
import { escapeHtml, escapeAttr } from "../../ui/format.js";
import { patchMeta, loadSessions } from "../../api/sessionsApi.js";
import { sendQuickPrompt } from "../../api/quickPromptsApi.js";
import { wireImagePaste } from "../../ui/pasteImage.js";

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
  const { resolvePromptText } = wireImagePaste(textEl);
  textEl.focus();
  // Enter sends (Shift+Enter still inserts a newline — that's the textarea's native behavior,
  // nothing to do for it), matching how chat-style prompt boxes usually behave.
  textEl.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      document.getElementById("qpGo").click();
    }
  });

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
      closeModal();
      openQuickPromptModal(id); // reopen fresh so the chip row reflects the removal
    });
  });

  document.getElementById("qpCancel").addEventListener("click", closeModal);
  document.getElementById("qpGo").addEventListener("click", async () => {
    const text = textEl.value.trim();
    if (!text) return;
    closeModal();
    await patchMeta(id, { promptHistory: nextPromptHistory(s, text) });
    await sendQuickPrompt(id, resolvePromptText(text));
    loadSessions();
  });
}
