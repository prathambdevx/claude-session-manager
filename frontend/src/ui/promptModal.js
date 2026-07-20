// Promise-based window.prompt() replacement — resolves the string on Save/Enter, null on cancel,
// same contract as the native prompt() it replaces.
import { modalShell, closeModal } from "./modalShell.js";
import { escapeHtml, escapeAttr } from "./format.js";

export function openPromptModal({ title = "Enter a value", label = "", value = "", placeholder = "", confirmLabel = "Save", multiline = false, validate = null } = {}) {
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
        <div class="modal-error" id="promptModalError" style="display:none;"></div>
      </div>
      <div class="modal-actions">
        <button id="promptModalCancel">Cancel</button>
        <button class="primary" id="promptModalOk">${escapeHtml(confirmLabel)}</button>
      </div>
    `, 380);

    const input = document.getElementById("promptModalInput");
    const errorEl = document.getElementById("promptModalError");
    input.focus();
    input.select();

    // validate() blocks the submit and surfaces its message inline instead of closing — used for
    // e.g. rejecting a duplicate column name without losing what the user already typed.
    const submit = () => {
      const err = validate?.(input.value);
      if (err) { errorEl.textContent = err; errorEl.style.display = "block"; return; }
      settle(input.value);
      closeModal();
    };
    document.getElementById("promptModalCancel").addEventListener("click", () => { settle(null); closeModal(); });
    document.getElementById("promptModalOk").addEventListener("click", submit);
    input.addEventListener("input", () => { errorEl.style.display = "none"; });
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
