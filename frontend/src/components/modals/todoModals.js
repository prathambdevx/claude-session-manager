import { todos, todoBoardColumns, sessions } from "../../state.js";
import { modalShell, closeModal } from "../../ui/modalShell.js";
import { escapeHtml, escapeAttr } from "../../ui/format.js";
import { modelSelectHtml, dangerousCheckboxHtml, dangerousDefault } from "../../ui/formFragments.js";
import { toast } from "../../ui/toast.js";
import { loadSessions } from "../../api/sessionsApi.js";
import { patchTodo } from "../todoBoard/patchTodo.js";
import { renderTodoBoard } from "../todoBoard/renderTodoBoard.js";

export function openTodoCreateModal(colId) {
  modalShell(`
    <h3>+ New Todo</h3>
    <div class="modal-row">
      <label for="todoTitle">Title</label>
      <input type="text" id="todoTitle" placeholder="What needs to be done?" />
    </div>
    <div class="modal-row">
      <label for="todoDesc">Description (optional)</label>
      <textarea id="todoDesc" class="notes-input" style="min-height:80px" placeholder="Add details, context, acceptance criteria..."></textarea>
    </div>
    <div class="modal-actions">
      <button id="todoCreateCancel">Cancel</button>
      <button class="primary" id="todoCreateSave">Create</button>
    </div>
  `);
  document.getElementById("todoCreateCancel").addEventListener("click", closeModal);
  document.getElementById("todoCreateSave").addEventListener("click", async () => {
    const title = document.getElementById("todoTitle").value.trim();
    if (!title) { toast("Give it a title"); return; }
    const description = document.getElementById("todoDesc").value.trim();
    const res = await fetch("/api/todos", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title, description: description || undefined, board: colId }),
    });
    const data = await res.json();
    if (data.ok) {
      todos.push(data.todo);
      closeModal();
      renderTodoBoard();
      toast("Todo created");
    } else {
      toast("Failed: " + (data.error || "unknown"));
    }
  });
}

export function openTodoEditModal(id) {
  const t = todos.find((x) => x.id === id);
  if (!t) return;
  modalShell(`
    <h3>Edit Todo</h3>
    <div class="modal-row">
      <label for="todoEditTitle">Title</label>
      <input type="text" id="todoEditTitle" value="${escapeAttr(t.title)}" />
    </div>
    <div class="modal-row">
      <label for="todoEditDesc">Description</label>
      <textarea id="todoEditDesc" class="notes-input" style="min-height:80px">${escapeHtml(t.description || "")}</textarea>
    </div>
    <div class="modal-row">
      <label for="todoEditStatus">Status</label>
      <select id="todoEditStatus">
        <option value="todo" ${t.status === "todo" ? "selected" : ""}>To Do</option>
        <option value="in-progress" ${t.status === "in-progress" ? "selected" : ""}>In Progress</option>
        <option value="done" ${t.status === "done" ? "selected" : ""}>Done</option>
      </select>
    </div>
    <div class="modal-actions">
      <button id="todoEditCancel">Cancel</button>
      <button class="primary" id="todoEditSave">Save</button>
    </div>
  `);
  document.getElementById("todoEditCancel").addEventListener("click", closeModal);
  document.getElementById("todoEditSave").addEventListener("click", async () => {
    const title = document.getElementById("todoEditTitle").value.trim();
    if (!title) { toast("Title is required"); return; }
    await patchTodo(id, {
      title,
      description: document.getElementById("todoEditDesc").value.trim() || undefined,
      status: document.getElementById("todoEditStatus").value,
    });
    closeModal();
    toast("Todo updated");
  });
}

export function openTodoAssignModal(id) {
  const t = todos.find((x) => x.id === id);
  if (!t) return;
  // auto-detect project from column's cwd
  const col = t.board ? todoBoardColumns.find((c) => c.id === t.board) : null;
  const colCwd = col?.cwd || "";
  const projectOptions = [...new Set(sessions.filter((s) => s.cwd && !s.isTicket).map((s) => s.cwd))].sort();
  const recentSessions = sessions
    .filter((s) => !s.isTicket)
    .sort((a, b) => b.lastActive - a.lastActive)
    .slice(0, 20);

  modalShell(`
    <h3>▶ Assign to Claude</h3>
    <div style="font-size:12px; color:var(--dim); margin-bottom:4px;">${escapeHtml(t.title)}</div>
    <div class="mode-toggle" style="max-width:300px;">
      <button id="assignNew" class="active">New session</button>
      <button id="assignExisting">Existing session</button>
    </div>
    <div id="assignNewFields">
      <div class="modal-row">
        <label for="assignProject">Project</label>
        <select id="assignProject">${projectOptions.map((p) => `<option value="${escapeAttr(p)}" ${p === colCwd ? "selected" : ""}>${escapeHtml(p)}</option>`).join("")}</select>
      </div>
      <div class="modal-row">
        <label for="assignModel">Model</label>
        ${modelSelectHtml("assignModel")}
      </div>
      ${dangerousCheckboxHtml("assignDangerous")}
    </div>
    <div id="assignExistingFields" style="display:none;">
      <div class="modal-row">
        <label for="assignSession">Pick a session</label>
        <select id="assignSession">
          ${recentSessions.map((s) => `<option value="${s.id}">${escapeHtml((s.meta?.name || s.firstMessage || s.id).slice(0, 60))}</option>`).join("")}
        </select>
      </div>
    </div>
    <div class="modal-actions">
      <button id="assignCancel">Cancel</button>
      <button class="primary" id="assignGo">▶ Assign</button>
    </div>
  `, 480);

  let mode = "new";
  document.getElementById("assignNew").addEventListener("click", () => {
    mode = "new";
    document.getElementById("assignNew").classList.add("active");
    document.getElementById("assignExisting").classList.remove("active");
    document.getElementById("assignNewFields").style.display = "";
    document.getElementById("assignExistingFields").style.display = "none";
  });
  document.getElementById("assignExisting").addEventListener("click", () => {
    mode = "existing";
    document.getElementById("assignExisting").classList.add("active");
    document.getElementById("assignNew").classList.remove("active");
    document.getElementById("assignNewFields").style.display = "none";
    document.getElementById("assignExistingFields").style.display = "";
  });
  document.getElementById("assignCancel").addEventListener("click", closeModal);
  document.getElementById("assignGo").addEventListener("click", async () => {
    let body;
    if (mode === "new") {
      const cwd = document.getElementById("assignProject").value;
      const model = document.getElementById("assignModel").value;
      const dangerous = document.getElementById("assignDangerous").checked;
      if (!cwd) { toast("Pick a project"); return; }
      body = { cwd, model: model || undefined, dangerous };
    } else {
      const sessionId = document.getElementById("assignSession").value;
      if (!sessionId) { toast("Pick a session"); return; }
      body = { sessionId, dangerous: dangerousDefault() };
    }
    const res = await fetch(`/api/todos/${id}/assign`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (data.ok) {
      const t2 = todos.find((x) => x.id === id);
      if (t2) { t2.assignedSessionId = data.sessionId; t2.status = "in-progress"; }
      closeModal();
      renderTodoBoard();
      toast("Assigned to Claude — session launched");
      loadSessions();
    } else {
      toast("Failed: " + (data.error || "unknown"));
    }
  });
}
