import { sessions } from "../../state.js";
import { modalShell, closeReviewModal } from "../../ui/modalShell.js";
import { escapeHtml } from "../../ui/format.js";
import { modelSelectHtml, dangerousCheckboxHtml } from "../../ui/formFragments.js";
import { toast } from "../../ui/toast.js";

export function openExtractModal(id) {
  const s = sessions.find((x) => x.id === id);
  if (!s) return;
  if (s.meta?.lastContextId) {
    openContextResultModal(s.meta.lastContextId, id);
    return;
  }
  modalShell(`
    <h3>🧠 Extract context from this session</h3>
    <div style="font-size:12px; color:var(--dim);">
      ${escapeHtml(s.meta?.name || s.meta?.description || (s.firstMessage || "").slice(0, 60))}
    </div>
    <div style="font-size:12.5px; color:var(--dim);">Condenses this session's task, decisions, files touched, and next steps into a short briefing — so you can start a fresh session without carrying the full history's token weight.</div>
    <div class="modal-row">
      <label for="extractModel">Model</label>
      ${modelSelectHtml("extractModel")}
    </div>
    <div class="modal-actions">
      <button id="extractCancel">Cancel</button>
      <button class="primary" id="extractStart">▶ Extract context</button>
    </div>
  `);
  document.getElementById("extractCancel").addEventListener("click", closeReviewModal);
  document.getElementById("extractStart").addEventListener("click", async () => {
    const model = document.getElementById("extractModel").value;
    modalShell(`
      <h3>🧠 Extracting context…</h3>
      <div style="font-size:12.5px; color:var(--dim);">Reading the full transcript and writing a condensed briefing — this can take a minute or two.</div>
    `);
    try {
      const res = await fetch(`/api/sessions/${id}/extract-context`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: model || undefined }),
      });
      const data = await res.json();
      if (data.ok) {
        const sess = sessions.find((x) => x.id === id);
        if (sess) sess.meta = { ...sess.meta, lastContextId: data.contextId };
        toast("Context extracted");
        openContextResultModal(data.contextId, id);
      } else {
        closeReviewModal();
        toast("Extraction failed: " + (data.error || "unknown error"));
      }
    } catch (e) {
      closeReviewModal();
      toast("Extraction failed: " + e.message);
    }
  });
}

export async function openContextResultModal(contextId, sessionId) {
  modalShell(`<h3>🧠 Loading context…</h3>`);
  const res = await fetch(`/api/contexts/${contextId}`);
  const data = await res.json();
  if (!data.context) {
    closeReviewModal();
    toast("Couldn't load that context");
    return;
  }
  modalShell(`
    <h3>🧠 Context extracted</h3>
    <a href="/contexts/${contextId}" target="_blank" rel="noopener" style="text-decoration:none;">
      <button class="primary" style="width:100%;">📄 Open context points in new tab</button>
    </a>
    <div class="modal-row">
      <label for="ctxName">Name the new session (optional)</label>
      <input type="text" id="ctxName" placeholder="e.g. wishlist-skeleton-continued" />
    </div>
    <div class="modal-row">
      <label for="ctxModel">Model</label>
      ${modelSelectHtml("ctxModel")}
    </div>
    ${dangerousCheckboxHtml("ctxDangerous")}
    <div class="modal-actions">
      <button id="ctxCancel">Close</button>
      <button id="ctxReExtract">↻ Re-extract</button>
      <button class="primary" id="ctxStart">▶ Start new session from this</button>
    </div>
  `);
  document.getElementById("ctxCancel").addEventListener("click", closeReviewModal);
  document.getElementById("ctxReExtract").addEventListener("click", () => {
    const sess = sessions.find((x) => x.id === sessionId);
    if (sess) sess.meta = { ...sess.meta, lastContextId: undefined };
    openExtractModal(sessionId);
  });
  document.getElementById("ctxStart").addEventListener("click", async () => {
    const name = document.getElementById("ctxName").value.trim();
    const model = document.getElementById("ctxModel").value;
    const dangerous = document.getElementById("ctxDangerous").checked;
    let data2;
    try {
      const res2 = await fetch(`/api/contexts/${contextId}/start`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: name || undefined, model: model || undefined, dangerous }),
      });
      data2 = await res2.json();
    } catch (e) {
      closeReviewModal();
      toast("Failed to start new session: " + e.message);
      return;
    }
    closeReviewModal();
    if (data2.ok) {
      toast(`New session${name ? ' "' + name + '"' : ""} launched in ${data2.cwd}`);
    } else {
      toast("Failed to start new session: " + (data2.error || "unknown error"));
    }
  });
}
