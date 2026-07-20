// Sidebar's top-level "All Projects" entry — the default landing page (the group lens: one column
// per project, read-only). Wired generically by viewsSection's [data-switch-view] handler.
import { activeView } from "../../state.js";

export function allProjectsNavHtml() {
  const active = activeView === "group";
  return `
    <div class="sidebar-item${active ? " active" : ""}" data-switch-view="group">
      <span class="sidebar-dot proj"></span>
      <span class="sidebar-label">All Projects</span>
    </div>
  `;
}
