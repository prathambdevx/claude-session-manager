import { sessions } from "../../state.js";
import { modalShell, closeReviewModal } from "../../ui/modalShell.js";
import { escapeHtml, escapeAttr, projectName } from "../../ui/format.js";
import { modelSelectHtml, dangerousCheckboxHtml } from "../../ui/formFragments.js";
import { toast } from "../../ui/toast.js";
import { launchTask, patchMeta, loadSessions } from "../../api/sessionsApi.js";
import { wireImagePaste } from "../../ui/pasteImage.js";

export function openColumnTaskModal(colId, ctx) {
  const col = ctx.cols.find((c) => c.id === colId);
  // A project's own board, or a project-tagged column on Main board, already knows which project
  // this task belongs to — no need to ask (and no way to get it wrong by picking a different one).
  const lockedCwd = ctx.kind === "project" ? ctx.cwd : col?.cwd || null;
  const projectOptions = [...new Set(sessions.map((s) => s.cwd))].sort();
  modalShell(`
    <h3>⚡ New task → ${escapeHtml(col?.title || colId)}</h3>
    <label class="modal-checkbox" title="A ticket is just a note to yourself — no Claude session is started" style="color:var(--ticket-ink); font-weight:600;">
      <input type="checkbox" id="colIsTicket" /> 🎫 Just a ticket (a note to do later — doesn't start a session)
    </label>
    <div class="modal-row">
      <label for="colTaskName" id="colNameLabel">Session name (optional)</label>
      <input type="text" id="colTaskName" placeholder="e.g. wishlist-skeleton" />
    </div>
    <div class="modal-row">
      <label for="colTaskDesc" id="colDescLabel">Task</label>
      <textarea id="colTaskDesc" class="notes-input" style="min-height:150px" placeholder="Describe the task..."></textarea>
    </div>
    <div class="session-only">
      <div class="modal-row">
        <label for="colTaskProject">Project</label>
        ${lockedCwd
          ? `<input type="text" id="colTaskProject" value="${escapeAttr(projectName(lockedCwd))}" data-locked-cwd="${escapeAttr(lockedCwd)}" disabled />`
          : `<select id="colTaskProject">${projectOptions.map((p) => `<option value="${escapeAttr(p)}">${escapeHtml(p)}</option>`).join("")}</select>`}
      </div>
      <div class="modal-row">
        <label for="colTaskModel">Model</label>
        ${modelSelectHtml("colTaskModel")}
      </div>
      ${dangerousCheckboxHtml("colTaskDangerous")}
    </div>
    <div class="modal-actions">
      <button id="colTaskCancel">Cancel</button>
      <button class="primary" id="colTaskStart">▶ Launch in new terminal</button>
    </div>
  `);
  const { resolvePromptText } = wireImagePaste(document.getElementById("colTaskDesc"));
  const isTicketBox = document.getElementById("colIsTicket");
  const syncTicketMode = () => {
    const t = isTicketBox.checked;
    document.querySelectorAll(".session-only").forEach((el) => (el.style.display = t ? "none" : ""));
    document.getElementById("colNameLabel").textContent = t ? "Ticket title" : "Session name (optional)";
    document.getElementById("colDescLabel").textContent = t ? "Task (optional)" : "Task";
    document.getElementById("colTaskStart").textContent = t ? "🎫 Create ticket" : "▶ Launch in new terminal";
  };
  isTicketBox.addEventListener("change", syncTicketMode);
  document.getElementById("colTaskCancel").addEventListener("click", closeReviewModal);
  document.getElementById("colTaskStart").addEventListener("click", async () => {
    const name = document.getElementById("colTaskName").value.trim();
    const desc = document.getElementById("colTaskDesc").value.trim();

    if (isTicketBox.checked) {
      const title = name || desc;
      if (!title) { toast("Give the ticket a title"); return; }
      const res = await fetch("/api/tickets", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title, notes: name ? desc : undefined, board: colId }),
      });
      const data = await res.json();
      closeReviewModal();
      if (data.ok) { toast("Ticket created"); loadSessions(); }
      else toast("Failed to create ticket: " + (data.error || "unknown error"));
      return;
    }

    const projectEl = document.getElementById("colTaskProject");
    const cwd = projectEl.dataset.lockedCwd || projectEl.value;
    const model = document.getElementById("colTaskModel").value;
    const dangerous = document.getElementById("colTaskDangerous").checked;
    const data = await launchTask({ cwd, task: resolvePromptText(desc), name, model, mode: "solo", dangerous });
    if (data?.ok) {
      closeReviewModal();
      if (data.sessionId) patchMeta(data.sessionId, { board: colId }); // drop the new session straight into the column it was launched from
    }
  });
}

export function convertTicketToSession(id) {
  const t = sessions.find((x) => x.id === id);
  if (!t) return;
  const projectOptions = [...new Set(sessions.filter((s) => s.cwd).map((s) => s.cwd))].sort();
  modalShell(`
    <h3>▶ Start session from ticket</h3>
    <div style="font-size:12px; color:var(--dim);">The ticket stays on the board and switches to a "Resume" button once the session launches.</div>
    <div class="modal-row">
      <label for="ctSessName">Session name (optional)</label>
      <input type="text" id="ctSessName" value="${escapeAttr(t.meta?.name || "")}" />
    </div>
    <div class="modal-row">
      <label for="ctSessProject">Project</label>
      <select id="ctSessProject">${projectOptions.map((p) => `<option value="${escapeAttr(p)}">${escapeHtml(p)}</option>`).join("")}</select>
    </div>
    <div class="modal-row">
      <label for="ctSessTask">Task</label>
      <textarea id="ctSessTask" class="notes-input" style="min-height:150px">${escapeHtml([t.meta?.name, t.meta?.notes].filter(Boolean).join(" — "))}</textarea>
    </div>
    <div class="modal-row">
      <label for="ctSessModel">Model</label>
      ${modelSelectHtml("ctSessModel")}
    </div>
    ${dangerousCheckboxHtml("ctSessDangerous")}
    <div class="modal-actions">
      <button id="ctSessCancel">Cancel</button>
      <button class="primary" id="ctSessGo">▶ Launch in new terminal</button>
    </div>
  `);
  const { resolvePromptText } = wireImagePaste(document.getElementById("ctSessTask"));
  document.getElementById("ctSessCancel").addEventListener("click", closeReviewModal);
  document.getElementById("ctSessGo").addEventListener("click", async () => {
    const cwd = document.getElementById("ctSessProject").value;
    const task = resolvePromptText(document.getElementById("ctSessTask").value.trim());
    const name = document.getElementById("ctSessName").value.trim();
    const model = document.getElementById("ctSessModel").value;
    const dangerous = document.getElementById("ctSessDangerous").checked;
    const data = await launchTask({ cwd, task, name, model, mode: "solo", dangerous });
    if (data?.ok) {
      closeReviewModal();
      if (data.sessionId) await patchMeta(id, { startedSessionId: data.sessionId }); // ticket keeps its board slot, now resumes the launched session
      loadSessions();
    }
  });
}
