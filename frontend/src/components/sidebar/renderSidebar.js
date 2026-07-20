// The board's left sidebar — just two things: All Projects (the group lens) and Views (saved
// column layouts). Rendered on every page pass alongside the board itself.
import { allProjectsNavHtml } from "./allProjectsNav.js";
import { viewsSectionHtml, wireViewsSection } from "./viewsSection.js";

export function renderSidebar() {
  const root = document.getElementById("sidebar");
  if (!root) return;

  root.innerHTML = `
    ${allProjectsNavHtml()}
    ${viewsSectionHtml()}
  `;

  wireViewsSection(root);
}
