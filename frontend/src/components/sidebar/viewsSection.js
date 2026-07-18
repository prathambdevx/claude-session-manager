// Sidebar "Views" section — Main board + saved views. Each view is a real URL (see switchToView in
// boardRouting), so a refresh stays on the current view. Saved views' ⋮ menu reuses .bc-dropdown.
import { activeView, boardMode, savedViews } from "../../state.js";
import { switchToView } from "../../routing/boardRouting.js";
import { escapeHtml } from "../../ui/format.js";
import { renameSavedView, deleteSavedView } from "../../api/savedViewsApi.js";
import { openPromptModal } from "../../ui/promptModal.js";
import { openConfirmModal } from "../../ui/confirmModal.js";

export { switchToView };

function viewRowHtml(id, label, opts = {}) {
  const active = boardMode === "main" && activeView === id;
  // menu data-attrs carry the RAW view id (opts.rawId), not the "saved:<id>" switch-view id — the
  // rename/delete handlers look the view up by its raw id and hit /api/saved-views/<raw id>
  const menu = opts.renameable
    ? `
      <div class="bc-menu-wrap">
        <button class="bc-menu-btn" data-view-menu-toggle="${opts.rawId}" title="Options">⋮</button>
        <div class="bc-dropdown" id="viewmenu-${opts.rawId}">
          <button data-rename-view="${opts.rawId}">✎ Rename</button>
          <button class="danger" data-delete-view="${opts.rawId}">🗑 Delete</button>
        </div>
      </div>`
    : "";
  return `
    <div class="sidebar-item${active ? " active" : ""}" data-switch-view="${id}">
      <span class="sidebar-dot"></span>
      <span class="sidebar-label">${escapeHtml(label)}</span>
      ${menu}
    </div>
  `;
}

export function viewsSectionHtml() {
  return `
    <div class="sidebar-group">Views</div>
    ${viewRowHtml("main", "Main board")}
    ${savedViews.map((v) => viewRowHtml(`saved:${v.id}`, v.title, { renameable: true, rawId: v.id })).join("")}
  `;
}

export function wireViewsSection(root) {
  root.querySelectorAll("[data-switch-view]").forEach((el) => {
    el.addEventListener("click", () => switchToView(el.dataset.switchView));
  });

  // same viewport-rect positioning as board card/column menus — the sidebar is too narrow for a
  // dropdown to just fall into its natural flow position without getting clipped by the board panel
  root.querySelectorAll("[data-view-menu-toggle]").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const dropdown = document.getElementById("viewmenu-" + btn.dataset.viewMenuToggle);
      const wasOpen = dropdown.classList.contains("open");
      document.querySelectorAll(".bc-dropdown.open").forEach((d) => d.classList.remove("open"));
      if (!wasOpen) {
        const rect = btn.getBoundingClientRect();
        const spaceBelow = window.innerHeight - rect.bottom;
        dropdown.style.left = rect.left + "px";
        dropdown.style.right = "";
        if (spaceBelow < 200) {
          dropdown.style.top = "";
          dropdown.style.bottom = (window.innerHeight - rect.top) + "px";
        } else {
          dropdown.style.top = rect.bottom + 4 + "px";
          dropdown.style.bottom = "";
        }
        dropdown.classList.add("open");
      }
    });
  });

  root.querySelectorAll("[data-rename-view]").forEach((btn) => {
    btn.addEventListener("click", async (e) => {
      e.stopPropagation();
      const id = btn.dataset.renameView;
      const view = savedViews.find((v) => v.id === id);
      const next = await openPromptModal({ title: "Rename view", label: "Title", value: view?.title || "" });
      if (next === null || !next.trim()) return;
      await renameSavedView(id, next.trim());
      await import("./renderSidebar.js").then((m) => m.renderSidebar());
    });
  });

  root.querySelectorAll("[data-delete-view]").forEach((btn) => {
    btn.addEventListener("click", async (e) => {
      e.stopPropagation();
      const id = btn.dataset.deleteView;
      const view = savedViews.find((v) => v.id === id);
      const ok = await openConfirmModal({
        title: `Delete "${view?.title}"?`,
        message: "This only removes the saved layout — it doesn't touch Main board or any sessions.",
        confirmLabel: "Delete",
        danger: true,
      });
      if (!ok) return;
      // if you're currently viewing the one being deleted, route back to Main board (URL + render)
      if (activeView === `saved:${id}`) await switchToView("main");
      await deleteSavedView(id);
      await import("./renderSidebar.js").then((m) => m.renderSidebar());
    });
  });
}
