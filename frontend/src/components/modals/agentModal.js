import { agents } from "../../state.js";
import { modalShell, closeReviewModal } from "../../ui/modalShell.js";
import { escapeHtml, escapeAttr } from "../../ui/format.js";
import { modelSelectHtml } from "../../ui/formFragments.js";
import { toast } from "../../ui/toast.js";
import { loadSessions } from "../../api/sessionsApi.js";
import { openConfirmModal } from "../../ui/confirmModal.js";

export function openAgentModal(agentId) {
  const a = agentId ? agents.find((x) => x.id === agentId) : null;
  const editing = !!a;
  modalShell(`
    <h3>${editing ? "✎ Edit agent" : "＋ New agent"}</h3>
    <div class="modal-row" style="flex-direction:row; gap:8px;">
      <input type="text" id="agEmoji" style="width:64px; text-align:center;" placeholder="🤖" value="${escapeAttr(a?.emoji || "")}" />
      <input type="text" id="agName" style="flex:1;" placeholder="Agent name (e.g. Publish, Changelog)" value="${escapeAttr(a?.name || "")}" />
    </div>
    <div class="modal-row">
      <label for="agPrompt">Instruction — what this agent does with the delegated session</label>
      <textarea id="agPrompt" class="notes-input" style="min-height:200px; font-size:13px;" placeholder="e.g. Review these changes for security bugs and edge cases, and write tests covering them.

The agent already inherits your shell auth (gh, npm login, etc.), so it can usually push/publish without any token. If a task needs a specific credential, you can paste it here (GitHub PAT, npm token, API key…) and tell the agent to use it — e.g. 'publish with npm token npm_xxx'.">${escapeHtml(a?.prompt || "")}</textarea>
    </div>
    <div class="modal-row">
      <label for="agModel">Model</label>
      ${modelSelectHtml("agModel", a?.model || "")}
    </div>
    <div class="modal-row">
      <label>Permission</label>
      <div class="mode-toggle">
        <button id="agPermRO" class="${!a || a.permission === "read-only" ? "active" : ""}" data-perm="read-only" title="Can read the repo, search, run commands — cannot edit files">👁 Read-only</button>
        <button id="agPermEdit" class="${a && a.permission === "edit" ? "active" : ""}" data-perm="edit" title="Full write access, dangerous mode — for publish/codegen/fixes">✎ Can edit files</button>
      </div>
    </div>
    <div class="modal-actions">
      ${editing ? `<button class="danger" id="agDelete">🗑 Delete</button>` : ""}
      <span style="flex:1"></span>
      <button id="agCancel">Cancel</button>
      <button class="primary" id="agSave">${editing ? "Save" : "Create"}</button>
    </div>
  `);
  let perm = a?.permission || "read-only";
  document.getElementById("agPermRO").addEventListener("click", () => {
    perm = "read-only";
    document.getElementById("agPermRO").classList.add("active");
    document.getElementById("agPermEdit").classList.remove("active");
  });
  document.getElementById("agPermEdit").addEventListener("click", () => {
    perm = "edit";
    document.getElementById("agPermEdit").classList.add("active");
    document.getElementById("agPermRO").classList.remove("active");
  });
  document.getElementById("agCancel").addEventListener("click", closeReviewModal);
  if (editing) {
    document.getElementById("agDelete").addEventListener("click", async () => {
      const ok = await openConfirmModal({ title: `Delete agent "${a.name}"?`, confirmLabel: "Delete", danger: true });
      if (!ok) { openAgentModal(agentId); return; } // confirm modal replaced this one — restore it
      await fetch(`/api/agents/${agentId}`, { method: "DELETE" });
      closeReviewModal();
      loadSessions();
      toast("Agent deleted");
    });
  }
  document.getElementById("agSave").addEventListener("click", async () => {
    const payload = {
      name: document.getElementById("agName").value.trim(),
      emoji: document.getElementById("agEmoji").value.trim() || "🤖",
      prompt: document.getElementById("agPrompt").value.trim(),
      model: document.getElementById("agModel").value || undefined,
      permission: perm,
    };
    if (!payload.name || !payload.prompt) { toast("Name and instruction are required"); return; }
    const res = await fetch(editing ? `/api/agents/${agentId}` : "/api/agents", {
      method: editing ? "PUT" : "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const data = await res.json();
    closeReviewModal();
    if (data.ok) { loadSessions(); toast(editing ? "Agent saved" : "Agent created"); }
    else toast("Failed: " + (data.error || "unknown error"));
  });
}
