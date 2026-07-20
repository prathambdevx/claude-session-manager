// Promise-based window.confirm() replacement matching the app's modal styling — resolves false on
// any dismissal (overlay/Escape), same as the native dialog.
import { modalShell, closeModal } from "./modalShell.js";
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

    document.getElementById("confirmModalCancel").addEventListener("click", () => { settle(false); closeModal(); });
    document.getElementById("confirmModalOk").addEventListener("click", () => { settle(true); closeModal(); });

    // Enter confirms (matches clicking the primary button) — no text input to worry about
    // stealing Enter from, this modal is just the message + two buttons.
    const onKeydown = (e) => {
      if (e.key === "Enter") document.getElementById("confirmModalOk")?.click();
    };
    document.addEventListener("keydown", onKeydown);

    const root = document.getElementById("modalRoot");
    const observer = new MutationObserver(() => {
      if (!root.firstChild) {
        settle(false);
        observer.disconnect();
        document.removeEventListener("keydown", onKeydown);
      }
    });
    observer.observe(root, { childList: true });
  });
}
