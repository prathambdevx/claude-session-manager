import { sessions } from "../state.js";
import { escapeHtml } from "../ui/format.js";

export function todoCardHtml(t) {
  const statusCls = t.status === "done" ? "s-done" : t.status === "in-progress" ? "s-in-progress" : "s-todo";
  const assignedSession = t.assignedSessionId ? sessions.find((s) => s.id === t.assignedSessionId) : null;
  const sessionLabel = assignedSession ? (assignedSession.meta?.name || assignedSession.meta?.description || assignedSession.firstMessage || "").slice(0, 30) : "";
  return `
    <div class="todo-card board-card" draggable="true" data-todo-id="${t.id}">
      <div class="tc-title">
        <span style="flex:1; min-width:0; overflow-wrap:anywhere;">${escapeHtml(t.title)}</span>
        <div class="bc-menu-wrap">
          <button class="bc-menu-btn" data-todo-menu="${t.id}" title="Options">⋮</button>
          <div class="bc-dropdown" id="todo-menu-${t.id}">
            <button data-todo-action="edit" data-todo-id="${t.id}">✎ Edit</button>
            <button data-todo-action="assign" data-todo-id="${t.id}">▶ Assign to Claude</button>
            ${t.status !== "done" ? `<button data-todo-action="done" data-todo-id="${t.id}">✓ Mark done</button>` : `<button data-todo-action="reopen" data-todo-id="${t.id}">↺ Reopen</button>`}
            <button class="danger" data-todo-action="delete" data-todo-id="${t.id}">🗑 Delete</button>
          </div>
        </div>
      </div>
      ${t.description ? `<div class="tc-desc">${escapeHtml(t.description)}</div>` : ""}
      <div class="tc-footer">
        <span class="tc-status ${statusCls}">${t.status || "todo"}</span>
        ${sessionLabel ? `<span class="tc-session">→ ${escapeHtml(sessionLabel)}</span>` : ""}
      </div>
    </div>
  `;
}
