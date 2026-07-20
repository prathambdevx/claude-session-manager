import { todos, todoBoardColumns } from "../../state.js";
import { escapeHtml } from "../../ui/format.js";
import { todoCardHtml } from "../../subcomponents/todoCard.js";
import { wireTodoBoard } from "./wireTodoBoard.js";

export function renderTodoBoard() {
  const todoApp = document.getElementById("todoApp");
  todoApp.classList.add("board-mode");
  const q = document.getElementById("search").value.trim().toLowerCase();
  const filtered = q ? todos.filter((t) => (t.title + " " + (t.description || "")).toLowerCase().includes(q)) : todos;

  const byCol = new Map(todoBoardColumns.map((c) => [c.id, []]));
  for (const t of filtered) {
    const col = t.board && byCol.has(t.board) ? t.board : todoBoardColumns[0].id;
    byCol.get(col).push(t);
  }
  // sort by most recently updated first
  for (const arr of byCol.values()) arr.sort((a, b) => b.updatedAt - a.updatedAt);

  todoApp.innerHTML = `
    <div class="board">
      ${todoBoardColumns.map((c) => `
        <div class="board-col" data-todo-col-id="${c.id}">
          <div class="board-col-header" draggable="true" data-todo-col-drag="${c.id}">
            <span class="drag-handle">⠿</span>
            <span>${escapeHtml(c.title)}</span>
            <span class="board-count">${(byCol.get(c.id) || []).length}</span>
            <div class="bc-menu-wrap" style="margin-left:auto;">
              <button class="bc-menu-btn" data-todo-col-menu="${c.id}" title="Column options">⋮</button>
              <div class="bc-dropdown" id="todo-col-menu-${c.id}">
                <button data-todo-col-action="add" data-col="${c.id}">+ New todo</button>
                <button data-todo-col-action="rename" data-col="${c.id}">✎ Rename</button>
                <button class="danger" data-todo-col-action="remove" data-col="${c.id}">✕ Remove</button>
              </div>
            </div>
          </div>
          <div class="board-col-body" data-todo-col-drop="${c.id}">
            ${(byCol.get(c.id) || []).map(todoCardHtml).join("") || '<div class="empty" style="padding:16px 0;">Drop here</div>'}
          </div>
        </div>
      `).join("")}
      <button class="add-col-btn" id="addTodoColBtn">+ Add column</button>
    </div>
  `;

  wireTodoBoard(todoApp);
}
