// The board's left sidebar — Views (Main board / Projects lens / saved views) above Projects
// (one row per project, drag-to-tag). Rendered on every page pass alongside the board itself.
import { viewsSectionHtml, wireViewsSection } from "./viewsSection.js";
import { projectsSectionHtml, wireProjectsSection } from "./projectsSection.js";

export function renderSidebar() {
  const root = document.getElementById("sidebar");
  if (!root) return;

  root.innerHTML = `
    ${viewsSectionHtml()}
    ${projectsSectionHtml()}
  `;

  wireViewsSection(root);
  wireProjectsSection(root);
}
