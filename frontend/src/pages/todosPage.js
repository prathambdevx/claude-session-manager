import { setCurrentTab } from "../state.js";
import { render } from "./sessionsPage.js";
import { renderTodoBoard } from "../components/todoBoard/renderTodoBoard.js";
import { onRouterPageOpen } from "./routerPage.js";

export function setTab(tab) {
  setCurrentTab(tab);
  localStorage.setItem("currentTab", tab);
  document.getElementById("tabSessions").classList.toggle("active", tab === "sessions");
  document.getElementById("tabTodos").classList.toggle("active", tab === "todos");
  document.getElementById("tabRouter")?.classList.toggle("active", tab === "router");
  const app = document.getElementById("app");
  const todoApp = document.getElementById("todoApp");
  const routerApp = document.getElementById("routerApp");
  const sidebar = document.getElementById("sidebar");
  // the sidebar is board-only; Todos and Router are single-column pages
  app.style.display = tab === "sessions" ? "" : "none";
  todoApp.style.display = tab === "todos" ? "" : "none";
  if (routerApp) routerApp.style.display = tab === "router" ? "" : "none";
  sidebar.style.display = tab === "sessions" ? "" : "none";
  if (tab === "sessions") render();
  else if (tab === "todos") renderTodoBoard();
  // Opening the Router warms the backend's standby `claude` process, so the seconds spent typing
  // a task cover the ~7.5s CLI boot instead of the decision paying for it.
  else if (tab === "router") onRouterPageOpen();
}

export function wireTabs() {
  document.getElementById("tabSessions").addEventListener("click", () => setTab("sessions"));
  document.getElementById("tabTodos").addEventListener("click", () => setTab("todos"));
  document.getElementById("tabRouter")?.addEventListener("click", () => setTab("router"));
}
