import { todos, setTodos, todoBoardColumns, setTodoBoardColumns } from "../../state.js";
import { toast } from "../../ui/toast.js";
import { saveTodoBoardColumns } from "../../api/sessionsApi.js";
import { openTodoCreateModal, openTodoEditModal, openTodoAssignModal } from "../modals/todoModals.js";
import { patchTodo } from "./patchTodo.js";
import { renderTodoBoard } from "./renderTodoBoard.js";
import { openPromptModal } from "../../ui/promptModal.js";
import { openConfirmModal } from "../../ui/confirmModal.js";

export function wireTodoBoard(app) {
  // card three-dot menu
  app.querySelectorAll("[data-todo-menu]").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const id = btn.dataset.todoMenu;
      const dropdown = document.getElementById("todo-menu-" + id);
      const wasOpen = dropdown.classList.contains("open");
      document.querySelectorAll(".bc-dropdown.open").forEach((d) => d.classList.remove("open"));
      if (!wasOpen) {
        const rect = btn.getBoundingClientRect();
        const spaceBelow = window.innerHeight - rect.bottom;
        dropdown.style.right = (window.innerWidth - rect.right) + "px";
        dropdown.style.left = "";
        if (spaceBelow < 200) { dropdown.style.top = ""; dropdown.style.bottom = (window.innerHeight - rect.top) + "px"; }
        else { dropdown.style.top = rect.bottom + 4 + "px"; dropdown.style.bottom = ""; }
        dropdown.classList.add("open");
      }
    });
  });

  // card actions
  app.querySelectorAll("[data-todo-action]").forEach((el) => {
    el.addEventListener("click", async (e) => {
      e.stopPropagation();
      const action = el.dataset.todoAction;
      const id = el.dataset.todoId;
      const t = todos.find((x) => x.id === id);
      if (action === "edit") openTodoEditModal(id);
      if (action === "assign") openTodoAssignModal(id);
      if (action === "done") await patchTodo(id, { status: "done" });
      if (action === "reopen") await patchTodo(id, { status: "todo" });
      if (action === "delete") {
        const ok = await openConfirmModal({ title: `Delete "${t?.title}"?`, confirmLabel: "Delete", danger: true });
        if (!ok) return;
        await fetch(`/api/todos/${id}`, { method: "DELETE" });
        setTodos(todos.filter((x) => x.id !== id));
        renderTodoBoard();
        toast("Todo deleted");
      }
    });
  });

  // column three-dot menu
  app.querySelectorAll("[data-todo-col-menu]").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const id = btn.dataset.todoColMenu;
      const dropdown = document.getElementById("todo-col-menu-" + id);
      const wasOpen = dropdown.classList.contains("open");
      document.querySelectorAll(".bc-dropdown.open").forEach((d) => d.classList.remove("open"));
      if (!wasOpen) {
        const rect = btn.getBoundingClientRect();
        dropdown.style.right = (window.innerWidth - rect.right) + "px";
        dropdown.style.left = "";
        dropdown.style.top = rect.bottom + 4 + "px";
        dropdown.style.bottom = "";
        dropdown.classList.add("open");
      }
    });
  });

  // column actions
  app.querySelectorAll("[data-todo-col-action]").forEach((el) => {
    el.addEventListener("click", async (e) => {
      e.stopPropagation();
      const action = el.dataset.todoColAction;
      const colId = el.dataset.col;
      if (action === "add") openTodoCreateModal(colId);
      if (action === "rename") {
        const col = todoBoardColumns.find((c) => c.id === colId);
        const next = await openPromptModal({ title: "Rename column", value: col?.title || "" });
        if (next && next.trim()) { col.title = next.trim(); saveTodoBoardColumns(); renderTodoBoard(); }
      }
      if (action === "remove") {
        const col = todoBoardColumns.find((c) => c.id === colId);
        if (todoBoardColumns.length <= 1) { toast("Need at least one column"); return; }
        const ok = await openConfirmModal({ title: `Remove column "${col?.title}"?`, confirmLabel: "Remove", danger: true });
        if (!ok) return;
        // move todos to first column
        todos.forEach((t) => { if (t.board === colId) patchTodo(t.id, { board: todoBoardColumns[0].id }); });
        setTodoBoardColumns(todoBoardColumns.filter((c) => c.id !== colId));
        saveTodoBoardColumns();
        renderTodoBoard();
      }
    });
  });

  // add column
  document.getElementById("addTodoColBtn")?.addEventListener("click", async () => {
    const title = await openPromptModal({ title: "New column", label: "Column name" });
    if (!title?.trim()) return;
    const id = title.trim().toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9-]/g, "");
    if (todoBoardColumns.some((c) => c.id === id)) { toast("Column already exists"); return; }
    todoBoardColumns.push({ id: id || crypto.randomUUID(), title: title.trim() });
    saveTodoBoardColumns();
    renderTodoBoard();
  });

  // drag & drop for todo cards
  app.querySelectorAll("[data-todo-id]").forEach((card) => {
    if (!card.classList.contains("todo-card")) return;
    card.addEventListener("dragstart", (e) => {
      e.dataTransfer.setData("text/todo-id", card.dataset.todoId);
      card.classList.add("dragging");
    });
    card.addEventListener("dragend", () => card.classList.remove("dragging"));
  });

  app.querySelectorAll("[data-todo-col-drop]").forEach((zone) => {
    zone.addEventListener("dragover", (e) => { e.preventDefault(); zone.closest(".board-col").classList.add("dragover"); });
    zone.addEventListener("dragleave", () => zone.closest(".board-col").classList.remove("dragover"));
    zone.addEventListener("drop", async (e) => {
      e.preventDefault();
      zone.closest(".board-col").classList.remove("dragover");
      const todoId = e.dataTransfer.getData("text/todo-id");
      if (!todoId) return;
      const colId = zone.dataset.todoColDrop;
      await patchTodo(todoId, { board: colId });
    });
  });

  // drag & drop for column reorder
  app.querySelectorAll("[data-todo-col-drag]").forEach((hdr) => {
    hdr.addEventListener("dragstart", (e) => {
      e.dataTransfer.setData("text/todo-col-drag", hdr.dataset.todoColDrag);
      hdr.closest(".board-col").classList.add("dragging");
    });
    hdr.addEventListener("dragend", () => hdr.closest(".board-col").classList.remove("dragging"));
  });
  app.querySelectorAll("[data-todo-col-id]").forEach((col) => {
    col.addEventListener("dragover", (e) => { if (e.dataTransfer.types.includes("text/todo-col-drag")) { e.preventDefault(); col.classList.add("dragover"); } });
    col.addEventListener("dragleave", () => col.classList.remove("dragover"));
    col.addEventListener("drop", (e) => {
      col.classList.remove("dragover");
      const fromId = e.dataTransfer.getData("text/todo-col-drag");
      if (!fromId) return;
      const toId = col.dataset.todoColId;
      if (fromId === toId) return;
      const fromIdx = todoBoardColumns.findIndex((c) => c.id === fromId);
      const toIdx = todoBoardColumns.findIndex((c) => c.id === toId);
      const [moved] = todoBoardColumns.splice(fromIdx, 1);
      todoBoardColumns.splice(toIdx, 0, moved);
      saveTodoBoardColumns();
      renderTodoBoard();
    });
  });
}
