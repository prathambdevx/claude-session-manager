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

// Shown open the very first time anyone loads the app (fresh install, no flag yet) — closing it
// (✕, clicking it, or clicking elsewhere) marks the flag so it never auto-opens again.
const VIEWS_INFO_SEEN_KEY = "viewsInfoSeen";

export function viewsSectionHtml() {
  return `
    <div class="sidebar-group">
      Views
      <button class="views-info-btn" data-views-info-toggle type="button" aria-expanded="false" title="What's a view?">i</button>
    </div>
    <div class="views-callout" data-views-callout>
      <div class="views-callout-head">
        <span class="tag">Views</span>
        <button class="views-callout-close" data-views-info-close type="button" title="Close">✕</button>
      </div>
      <p><b>A view is a saved column layout.</b> "Main board" is the one you start with.</p>
      <p>Arrange your columns how you like, then <b>＋ Save as view</b> to keep that arrangement here
      — switch between as many as you want, anytime.</p>
    </div>
    ${viewRowHtml("main", "Main board")}
    ${savedViews.map((v) => viewRowHtml(`saved:${v.id}`, v.title, { renameable: true, rawId: v.id })).join("")}
  `;
}

// #sidebar has overflow-y:auto, which per the CSS overflow spec forces overflow-x to clip too — an
// absolutely-positioned popover meant to float past the sidebar's right edge would be silently cut
// off. Fixed position + real screen coordinates (same trick the saved-view ⋮ menu below already
// uses) escapes that entirely. Anchored off the sidebar's own right edge (not the tiny icon itself)
// so it floats well clear of the sidebar, matching the reference mock.
function positionCallout(anchorBtn, sidebarEl, callout) {
  const btnRect = anchorBtn.getBoundingClientRect();
  const sidebarRect = sidebarEl.getBoundingClientRect();
  callout.style.left = sidebarRect.right + 14 + "px";
  callout.style.top = btnRect.top - 12 + "px";
}

// Registered once at module load, not per-render — the sidebar re-renders wholesale on every
// change, so a per-render listener would stack a fresh one each time. Queries the live element
// fresh on every click instead of holding a stale reference.
document.addEventListener("click", (e) => {
  const callout = document.querySelector("[data-views-callout]");
  const toggleBtn = document.querySelector("[data-views-info-toggle]");
  if (!callout?.classList.contains("show")) return;
  if (callout.contains(e.target) || e.target === toggleBtn) return;
  callout.classList.remove("show");
  toggleBtn?.setAttribute("aria-expanded", "false");
  localStorage.setItem(VIEWS_INFO_SEEN_KEY, "1");
});

export function wireViewsSection(root) {
  root.querySelectorAll("[data-switch-view]").forEach((el) => {
    el.addEventListener("click", () => switchToView(el.dataset.switchView));
  });

  const infoBtn = root.querySelector("[data-views-info-toggle]");
  const callout = root.querySelector("[data-views-callout]");
  const openCallout = () => {
    positionCallout(infoBtn, root, callout);
    callout.classList.add("show");
    infoBtn.setAttribute("aria-expanded", "true");
  };
  const closeCallout = () => {
    callout.classList.remove("show");
    infoBtn.setAttribute("aria-expanded", "false");
    localStorage.setItem(VIEWS_INFO_SEEN_KEY, "1");
  };
  infoBtn?.addEventListener("click", (e) => {
    e.stopPropagation();
    if (callout.classList.contains("show")) closeCallout();
    else openCallout();
  });
  callout?.addEventListener("click", (e) => {
    e.stopPropagation();
    closeCallout();
  });
  if (infoBtn && callout && !localStorage.getItem(VIEWS_INFO_SEEN_KEY)) openCallout();

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
