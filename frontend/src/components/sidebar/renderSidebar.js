// The board's left sidebar: the app's name and logo (the top header is hidden), All Projects (the group
// lens) and Views (saved column layouts). Rendered on every page pass alongside the board itself.
import { allProjectsNavHtml } from "./allProjectsNav.js";
import { viewsSectionHtml, wireViewsSection } from "./viewsSection.js";

export function renderSidebar() {
  const root = document.getElementById("sidebar");
  if (!root) return;

  root.innerHTML = `
    <div class="sidebar-brand"><img src="/favicon.webp" alt="" />Claude Sessions</div>
    ${allProjectsNavHtml()}
    ${viewsSectionHtml()}
  `;

  wireViewsSection(root);
}
