// Promise-based window.prompt() replacement — resolves the string on Save/Enter, null on cancel,
// same contract as the native prompt() it replaces.
import { modalShell, closeReviewModal } from "./modalShell.js";
import { escapeHtml, escapeAttr } from "./format.js";

export function openPromptModal({ title = "Enter a value", label = "", value = "", placeholder = "", confirmLabel = "Save", multiline = false } = {}) {
  return new Promise((resolve) => {
    let settled = false;
    const settle = (v) => { if (settled) return; settled = true; resolve(v); };

    modalShell(`
      <h3>${escapeHtml(title)}</h3>
      <div class="modal-row">
        ${label ? `<label for="promptModalInput">${escapeHtml(label)}</label>` : ""}
        ${multiline
          ? `<textarea id="promptModalInput" class="notes-input" style="min-height:70px" placeholder="${escapeAttr(placeholder)}">${escapeHtml(value)}</textarea>`
          : `<input type="text" id="promptModalInput" value="${escapeAttr(value)}" placeholder="${escapeAttr(placeholder)}" />`}
      </div>
      <div class="modal-actions">
        <button id="promptModalCancel">Cancel</button>
        <button class="primary" id="promptModalOk">${escapeHtml(confirmLabel)}</button>
      </div>
    `, 380);

    const input = document.getElementById("promptModalInput");
    input.focus();
    input.select();

    const submit = () => { settle(input.value); closeReviewModal(); };
    document.getElementById("promptModalCancel").addEventListener("click", () => { settle(null); closeReviewModal(); });
    document.getElementById("promptModalOk").addEventListener("click", submit);
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !multiline) { e.preventDefault(); submit(); }
    });

    const root = document.getElementById("modalRoot");
    const observer = new MutationObserver(() => {
      if (!root.firstChild) { settle(null); observer.disconnect(); }
    });
    observer.observe(root, { childList: true });
  });
}
