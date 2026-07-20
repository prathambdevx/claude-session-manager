import { sessions } from "../../state.js";
import { modalShell, closeModal } from "../../ui/modalShell.js";
import { escapeHtml, escapeAttr, projectName } from "../../ui/format.js";
import { modelSelectHtml, dangerousCheckboxHtml } from "../../ui/formFragments.js";
import { toast } from "../../ui/toast.js";
import { launchTask, patchMeta, loadSessions } from "../../api/sessionsApi.js";
import { wireImagePaste } from "../../ui/pasteImage.js";
import { setBoardTag } from "../../routing/boardRouting.js";

const LAST_TASK_PROJECT_KEY = "lastTaskProjectCwd";

export function openColumnTaskModal(colId, ctx) {
  const col = ctx.cols.find((c) => c.id === colId);
  // A project-tagged column already knows which project this task belongs to — no need to ask
  // (and no way to get it wrong by picking a different one).
  const lockedCwd = col?.cwd || null;
  const projectOptions = [...new Set(sessions.filter((s) => s.cwd).map((s) => s.cwd))].sort((a, b) => projectName(a).localeCompare(projectName(b)));
  const lastCwd = localStorage.getItem(LAST_TASK_PROJECT_KEY);
  // A ticket has no fixed project, so it can never actually show up on a project-dedicated column
  // (membership there is computed purely by cwd) — offering the checkbox there would silently
  // create a ticket with nowhere to land.
  const canBeTicket = !col?.cwd;
  modalShell(`
    <h3>⚡ New task → ${escapeHtml(col?.title || colId)}</h3>
    ${canBeTicket ? `
    <label class="modal-checkbox" title="A ticket is just a note to yourself — no Claude session is started" style="color:var(--ticket-ink); font-weight:600;">
      <input type="checkbox" id="colIsTicket" /> 🎫 Just a ticket (a note to do later — doesn't start a session)
    </label>` : ""}
    <div class="modal-row">
      <label for="colTaskName" id="colNameLabel">Session name (optional)</label>
      <input type="text" id="colTaskName" placeholder="e.g. wishlist-skeleton" />
    </div>
    <div class="modal-row">
      <label for="colTaskDesc" id="colDescLabel">Prompt</label>
      <textarea id="colTaskDesc" class="notes-input" style="min-height:150px" placeholder="Describe your task"></textarea>
    </div>
    <div class="session-only">
      <div class="modal-row">
        <label for="colTaskProject">Project${lockedCwd ? ` <span title="Set by the column this task was created from — can't be changed here" style="opacity:0.7; font-size:11px;">🔒</span>` : ""}</label>
        ${lockedCwd
          ? `<input type="text" id="colTaskProject" value="${escapeAttr(projectName(lockedCwd))}" data-locked-cwd="${escapeAttr(lockedCwd)}" disabled />`
          : `<select id="colTaskProject">${projectOptions.map((p) => `<option value="${escapeAttr(p)}" ${p === lastCwd ? "selected" : ""}>${escapeHtml(projectName(p))}</option>`).join("")}</select>`}
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
  // Persisted as soon as you pick a project — not deferred until launch — so it's remembered even
  // if you close the modal without ever hitting Launch.
  if (!lockedCwd) {
    document.getElementById("colTaskProject").addEventListener("change", (e) => {
      localStorage.setItem(LAST_TASK_PROJECT_KEY, e.target.value);
    });
  }
  const isTicketBox = document.getElementById("colIsTicket");
  if (isTicketBox) {
    const syncTicketMode = () => {
      const t = isTicketBox.checked;
      document.querySelectorAll(".session-only").forEach((el) => (el.style.display = t ? "none" : ""));
      document.getElementById("colNameLabel").textContent = t ? "Ticket title" : "Session name (optional)";
      document.getElementById("colDescLabel").textContent = t ? "Prompt (optional)" : "Prompt";
      document.getElementById("colTaskStart").textContent = t ? "🎫 Create ticket" : "▶ Launch in new terminal";
    };
    isTicketBox.addEventListener("change", syncTicketMode);
  }
  // Enter launches/creates (Shift+Enter still inserts a newline), matching Quick Prompt's textarea.
  document.getElementById("colTaskDesc").addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      document.getElementById("colTaskStart").click();
    }
  });
  document.getElementById("colTaskCancel").addEventListener("click", closeModal);
  document.getElementById("colTaskStart").addEventListener("click", async () => {
    const name = document.getElementById("colTaskName").value.trim();
    const desc = document.getElementById("colTaskDesc").value.trim();

    if (isTicketBox?.checked) {
      const title = name || desc;
      if (!title) { toast("Give the ticket a title"); return; }
      const res = await fetch("/api/tickets", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title, notes: name ? desc : undefined }),
      });
      const data = await res.json();
      closeModal();
      if (data.ok) {
        await setBoardTag(ctx, data.ticket.id, colId, true);
        toast("Ticket created");
        loadSessions();
      } else toast("Failed to create ticket: " + (data.error || "unknown error"));
      return;
    }

    const projectEl = document.getElementById("colTaskProject");
    const cwd = projectEl.dataset.lockedCwd || projectEl.value;
    const model = document.getElementById("colTaskModel").value;
    const dangerous = document.getElementById("colTaskDangerous").checked;
    const data = await launchTask({ cwd, task: resolvePromptText(desc), name, model, dangerous });
    if (data?.ok) {
      closeModal();
      if (data.sessionId) setBoardTag(ctx, data.sessionId, colId); // drop the new session straight into the column it was launched from
    }
  });
}

export function convertTicketToSession(id) {
  const t = sessions.find((x) => x.id === id);
  if (!t) return;
  const projectOptions = [...new Set(sessions.filter((s) => s.cwd).map((s) => s.cwd))].sort((a, b) => projectName(a).localeCompare(projectName(b)));
  modalShell(`
    <h3>▶ Start session from ticket</h3>
    <div style="font-size:12px; color:var(--dim);">The ticket stays on the board and switches to a "Resume" button once the session launches.</div>
    <div class="modal-row">
      <label for="ctSessName">Session name (optional)</label>
      <input type="text" id="ctSessName" value="${escapeAttr(t.meta?.name || "")}" />
    </div>
    <div class="modal-row">
      <label for="ctSessProject">Project</label>
      <select id="ctSessProject">${projectOptions.map((p) => `<option value="${escapeAttr(p)}">${escapeHtml(projectName(p))}</option>`).join("")}</select>
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
  document.getElementById("ctSessCancel").addEventListener("click", closeModal);
  document.getElementById("ctSessGo").addEventListener("click", async () => {
    const cwd = document.getElementById("ctSessProject").value;
    const task = resolvePromptText(document.getElementById("ctSessTask").value.trim());
    const name = document.getElementById("ctSessName").value.trim();
    const model = document.getElementById("ctSessModel").value;
    const dangerous = document.getElementById("ctSessDangerous").checked;
    const data = await launchTask({ cwd, task, name, model, dangerous });
    if (data?.ok) {
      closeModal();
      if (data.sessionId) await patchMeta(id, { startedSessionId: data.sessionId }); // ticket keeps its board slot, now resumes the launched session
      loadSessions();
    }
  });
}
