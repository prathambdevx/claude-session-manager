import { todos } from "../../state.js";
import { renderTodoBoard } from "./renderTodoBoard.js";

export async function patchTodo(id, patch) {
  const t = todos.find((x) => x.id === id);
  if (t) Object.assign(t, patch);
  renderTodoBoard();
  await fetch(`/api/todos/${id}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(patch),
  });
}
