// A promise-based replacement for window.confirm() that matches the app's own modal styling
// instead of the browser's native dialog. Resolves true/false; closing any other way (overlay
// click, Escape) resolves false via the MutationObserver below, same as dismissing a native confirm.
import { modalShell, closeReviewModal } from "./modalShell.js";
import { escapeHtml } from "./format.js";

export function openConfirmModal({ title = "Are you sure?", message = "", confirmLabel = "Confirm", cancelLabel = "Cancel", danger = false } = {}) {
  return new Promise((resolve) => {
    let settled = false;
    const settle = (v) => { if (settled) return; settled = true; resolve(v); };

    modalShell(`
      <h3>${escapeHtml(title)}</h3>
      ${message ? `<div style="font-size:12.5px; color:var(--dim);">${escapeHtml(message)}</div>` : ""}
      <div class="modal-actions">
        <button id="confirmModalCancel">${escapeHtml(cancelLabel)}</button>
        <button class="primary${danger ? " danger" : ""}" id="confirmModalOk">${escapeHtml(confirmLabel)}</button>
      </div>
    `, 380);

    document.getElementById("confirmModalCancel").addEventListener("click", () => { settle(false); closeReviewModal(); });
    document.getElementById("confirmModalOk").addEventListener("click", () => { settle(true); closeReviewModal(); });

    const root = document.getElementById("modalRoot");
    const observer = new MutationObserver(() => {
      if (!root.firstChild) { settle(false); observer.disconnect(); }
    });
    observer.observe(root, { childList: true });
  });
}
