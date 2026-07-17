import { modalShell, closeReviewModal } from "../../ui/modalShell.js";
import { escapeHtml, escapeAttr } from "../../ui/format.js";
import { patchMeta } from "../../api/sessionsApi.js";

export function openRenameModal(id, currentName, label) {
  modalShell(`
    <h3>✎ ${escapeHtml(label)}</h3>
    <div class="modal-row">
      <input type="text" id="renameInput" value="${escapeAttr(currentName || "")}" placeholder="Untitled" />
    </div>
    <div class="modal-actions">
      <button id="renameCancel">Cancel</button>
      <button class="primary" id="renameSave">Save</button>
    </div>
  `, 380);
  const input = document.getElementById("renameInput");
  input.focus();
  input.select();
  const save = () => {
    patchMeta(id, { name: input.value.trim() || null });
    closeReviewModal();
  };
  document.getElementById("renameCancel").addEventListener("click", closeReviewModal);
  document.getElementById("renameSave").addEventListener("click", save);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); save(); }
  });
}
