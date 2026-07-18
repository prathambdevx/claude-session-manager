// Sidebar "Views" section — Main board, Projects lens, saved views, each with a ★ default-view
// toggle; saved views' ⋮ menu reuses the app's .bc-dropdown.open convention.
import { activeView, setActiveView, boardMode, savedViews, defaultViewId } from "../../state.js";
import { setBoardMode } from "../../routing/boardRouting.js";
import { escapeHtml } from "../../ui/format.js";
import { toast } from "../../ui/toast.js";
import { renameSavedView, deleteSavedView } from "../../api/savedViewsApi.js";
import { saveDefaultViewId } from "../../api/boardSettingsApi.js";
import { openPromptModal } from "../../ui/promptModal.js";
import { openConfirmModal } from "../../ui/confirmModal.js";

export async function switchToView(view) {
  if (boardMode !== "main") await setBoardMode("main");
  setActiveView(view);
  await import("../../pages/sessionsPage.js").then((m) => m.render());
}

async function setDefault(id, label) {
  await saveDefaultViewId(id);
  toast(`"${label}" will load next time you open the board`);
  await import("./renderSidebar.js").then((m) => m.renderSidebar());
}

function viewRowHtml(id, label, opts = {}) {
  const active = boardMode === "main" && activeView === id;
  const star = `<span class="star${defaultViewId === id ? " set" : ""}" data-set-default="${id}" data-default-label="${escapeHtml(label)}" title="${defaultViewId === id ? "Default view" : "Make this the default view"}">★</span>`;
  const menu = opts.renameable
    ? `
      <div class="bc-menu-wrap">
        <button class="bc-menu-btn" data-view-menu-toggle="${id}" title="Options">⋮</button>
        <div class="bc-dropdown" id="viewmenu-${id}">
          <button data-rename-view="${id}">✎ Rename</button>
          <button class="danger" data-delete-view="${id}">🗑 Delete</button>
        </div>
      </div>`
    : "";
  return `
    <div class="sidebar-item${active ? " active" : ""}" data-switch-view="${id}">
      <span class="sidebar-dot"></span>
      <span class="sidebar-label">${escapeHtml(label)}</span>
      ${star}
      ${menu}
    </div>
  `;
}

export function viewsSectionHtml() {
  return `
    <div class="sidebar-group">Views</div>
    ${viewRowHtml("main", "Main board")}
    ${viewRowHtml("group", "Projects")}
    ${savedViews.map((v) => viewRowHtml(`saved:${v.id}`, v.title, { renameable: true })).join("")}
  `;
}

export function wireViewsSection(root) {
  root.querySelectorAll("[data-switch-view]").forEach((el) => {
    el.addEventListener("click", () => switchToView(el.dataset.switchView));
  });

  root.querySelectorAll("[data-set-default]").forEach((el) => {
    el.addEventListener("click", (e) => {
      e.stopPropagation();
      setDefault(el.dataset.setDefault, el.dataset.defaultLabel);
    });
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
      if (activeView === `saved:${id}`) setActiveView("main");
      await deleteSavedView(id);
      await import("./renderSidebar.js").then((m) => m.renderSidebar());
    });
  });
}
