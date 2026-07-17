import { setCurrentTab } from "../state.js";
import { render } from "./sessionsPage.js";
import { renderTodoBoard } from "../components/todoBoard/renderTodoBoard.js";

export function setTab(tab) {
  setCurrentTab(tab);
  localStorage.setItem("currentTab", tab);
  document.getElementById("tabSessions").classList.toggle("active", tab === "sessions");
  document.getElementById("tabTodos").classList.toggle("active", tab === "todos");
  const app = document.getElementById("app");
  const todoApp = document.getElementById("todoApp");
  const sidebar = document.getElementById("sidebar");
  if (tab === "sessions") {
    app.style.display = "";
    todoApp.style.display = "none";
    sidebar.style.display = "";
    render();
  } else {
    app.style.display = "none";
    todoApp.style.display = "";
    sidebar.style.display = "none";
    renderTodoBoard();
  }
}

export function wireTabs() {
  document.getElementById("tabSessions").addEventListener("click", () => setTab("sessions"));
  document.getElementById("tabTodos").addEventListener("click", () => setTab("todos"));
}
