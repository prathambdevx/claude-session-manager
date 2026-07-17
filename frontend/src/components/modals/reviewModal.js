import { sessions } from "../../state.js";
import { modalShell, closeReviewModal } from "../../ui/modalShell.js";
import { escapeHtml } from "../../ui/format.js";
import { modelSelectHtml, dangerousCheckboxHtml } from "../../ui/formFragments.js";
import { toast } from "../../ui/toast.js";

export function openReviewModal(id) {
  const s = sessions.find((x) => x.id === id);
  if (!s) return;
  if (s.meta?.lastReviewId) {
    openFixModal(s.meta.lastReviewId, s.changedFiles?.length ?? 0, id);
    return;
  }
  if (!s.changedFiles || !s.changedFiles.length) {
    toast("No changed files found in this session's transcript");
    return;
  }
  modalShell(`
    <h3>🔎 Send to reviewer agent</h3>
    <div style="font-size:12px; color:var(--dim);">
      ${escapeHtml(s.meta?.name || s.meta?.description || (s.firstMessage || "").slice(0, 60))}
      — ${s.changedFiles.length} file${s.changedFiles.length === 1 ? "" : "s"} this session touched
    </div>
    <div class="file-list">${s.changedFiles.map(escapeHtml).join("<br/>")}</div>
    <div class="modal-row">
      <label for="reviewFocus">Focus (optional) — leave blank to review everything</label>
      <textarea id="reviewFocus" class="notes-input" style="min-height:80px; font-size:13px;" placeholder="e.g. review the wishlist feature only — focus on the N+1 query risk in the data-fetching layer and error handling on empty carts"></textarea>
    </div>
    <div class="modal-row">
      <label for="reviewModel">Model</label>
      ${modelSelectHtml("reviewModel")}
    </div>
    <div class="modal-actions">
      <button id="reviewCancel">Cancel</button>
      <button class="primary" id="reviewStart">▶ Start review</button>
    </div>
  `);
  document.getElementById("reviewCancel").addEventListener("click", closeReviewModal);
  document.getElementById("reviewFocus").focus();
  document.getElementById("reviewStart").addEventListener("click", async () => {
    const model = document.getElementById("reviewModel").value;
    const focus = document.getElementById("reviewFocus").value.trim();
    modalShell(`
      <h3>🔎 Reviewing…</h3>
      <div style="font-size:12.5px; color:var(--dim);">${focus ? "Reviewing: " + escapeHtml(focus) + " — " : ""}reading ${s.changedFiles.length} file${s.changedFiles.length === 1 ? "" : "s"} and writing up findings in plain English — this can take a minute or two.</div>
    `);
    try {
      const res = await fetch(`/api/sessions/${id}/review`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: model || undefined, focus: focus || undefined }),
      });
      const data = await res.json();
      if (data.ok) {
        const sess = sessions.find((x) => x.id === id);
        if (sess) sess.meta = { ...sess.meta, lastReviewId: data.reviewId };
        openFixModal(data.reviewId, data.fileCount, id);
      } else {
        closeReviewModal();
        toast("Review failed: " + (data.error || "unknown error"));
      }
    } catch (e) {
      closeReviewModal();
      toast("Review failed: " + e.message);
    }
  });
}

export async function openFixModal(reviewId, fileCount, sessionId) {
  modalShell(`<h3>🔎 Loading review…</h3>`);
  const res = await fetch(`/api/reviews/${reviewId}`);
  const data = await res.json();
  if (!data.review) {
    closeReviewModal();
    toast("Couldn't load that review");
    return;
  }
  const review = data.review;
  modalShell(`
    <h3>📄 Review ready</h3>
    <div style="font-size:12.5px; color:var(--dim);">${fileCount || review.files.length} file${(fileCount || review.files.length) === 1 ? "" : "s"} reviewed, in plain English.</div>
    <a href="/reviews/${review.id}" target="_blank" rel="noopener" style="text-decoration:none;">
      <button class="primary" style="width:100%;">📄 Open full report in new tab</button>
    </a>
    <div class="modal-row">
      <label for="fixNumbers">Fix only these finding numbers (e.g. "1 2 6") — leave blank + use Fix All instead</label>
      <input type="text" id="fixNumbers" class="description-input" placeholder="1 2 6" />
    </div>
    <label class="modal-checkbox">
      <input type="checkbox" id="fixWriteTests" />
      Also write test cases for the fix and run them
    </label>
    ${dangerousCheckboxHtml("fixDangerous")}
    <div class="modal-actions">
      <button id="fixCancel">Close</button>
      <button id="fixSelected">▶ Fix selected</button>
      <button class="primary" id="fixAll">▶ Fix all</button>
    </div>
  `);
  document.getElementById("fixCancel").addEventListener("click", closeReviewModal);
  const runFix = async (selection) => {
    const writeTests = document.getElementById("fixWriteTests").checked;
    const dangerous = document.getElementById("fixDangerous").checked;
    let data2;
    try {
      const res2 = await fetch(`/api/reviews/${reviewId}/fix`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ selection, writeTests, dangerous }),
      });
      data2 = await res2.json();
    } catch (e) {
      closeReviewModal();
      toast("Failed to start fix: " + e.message);
      return;
    }
    closeReviewModal();
    if (data2.ok) {
      toast(`Fix launched in ${data2.cwd}${writeTests ? " + writing tests" : ""}`);
    } else {
      toast("Failed to start fix: " + (data2.error || "unknown error"));
    }
  };
  document.getElementById("fixAll").addEventListener("click", () => runFix("all"));
  document.getElementById("fixSelected").addEventListener("click", () => {
    const val = document.getElementById("fixNumbers").value.trim();
    if (!val) { toast("Enter finding numbers first, or use Fix All"); return; }
    runFix(val);
  });
}
