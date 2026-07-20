// Sidebar "Views" section — every saved view, empty-state text when there are none. Each view is
// a real URL (see switchToView in boardRouting), so a refresh stays on the current view. Saved
// views' ⋮ menu reuses .bc-dropdown.
import { activeView, savedViews } from "../../state.js";
import { switchToView, createView } from "../../routing/boardRouting.js";
import { escapeHtml } from "../../ui/format.js";
import { renameSavedView, deleteSavedView } from "../../api/savedViewsApi.js";
import { openPromptModal } from "../../ui/promptModal.js";
import { openConfirmModal } from "../../ui/confirmModal.js";

export { switchToView };

// SVG cross instead of a text "+" so stroke weight stays crisp at any size, independent of font
// rendering — same technique as the column header's "+ New" icon.
const PLUS_ICON = `<svg width="10" height="10" viewBox="0 0 14 14" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><path d="M7 1v12M1 7h12" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>`;

function viewRowHtml(view) {
  const id = `saved:${view.id}`;
  const active = activeView === id;
  return `
    <div class="sidebar-item${active ? " active" : ""}" data-switch-view="${id}">
      <span class="sidebar-dot"></span>
      <span class="sidebar-label">${escapeHtml(view.title)}</span>
      <div class="bc-menu-wrap">
        <button class="bc-menu-btn" data-view-menu-toggle="${view.id}" title="Options">⋮</button>
        <div class="bc-dropdown" id="viewmenu-${view.id}">
          <button data-rename-view="${view.id}">✎ Rename</button>
          <button class="danger" data-delete-view="${view.id}">🗑 Delete</button>
        </div>
      </div>
    </div>
  `;
}

// Shown open the very first time anyone loads the app (fresh install, no flag yet) — closing it
// (✕, clicking it, or clicking elsewhere) marks the flag so it never auto-opens again.
const VIEWS_INFO_SEEN_KEY = "viewsInfoSeen";

// Tracked here, not just as a DOM class, so a sidebar rebuild (poll/SSE/any render()) doesn't
// silently drop it mid-read — isTransientUiOpen() checks this too.
let calloutOpen = false;

export function viewsSectionHtml() {
  return `
    <div class="sidebar-group">
      Views
      <button class="views-info-btn" data-views-info-toggle type="button" aria-expanded="${calloutOpen}" title="What's a view?">i</button>
      <span class="sidebar-group-spacer"></span>
      <button class="add-view-btn" data-create-view type="button" title="Create a view">${PLUS_ICON}</button>
    </div>
    <div class="views-callout${calloutOpen ? " show" : ""}" data-views-callout>
      <div class="views-callout-head">
        <span class="tag">Views</span>
        <button class="views-callout-close" data-views-info-close type="button" title="Close">✕</button>
      </div>
      <p>You can create your custom views here — arrange columns however you like.</p>
    </div>
    ${savedViews.length ? savedViews.map(viewRowHtml).join("") : '<div class="sidebar-empty-hint">No custom views created.</div>'}
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
  calloutOpen = false;
  callout.classList.remove("show");
  toggleBtn?.setAttribute("aria-expanded", "false");
  localStorage.setItem(VIEWS_INFO_SEEN_KEY, "1");
});

export function wireViewsSection(root) {
  root.querySelectorAll("[data-switch-view]").forEach((el) => {
    el.addEventListener("click", () => switchToView(el.dataset.switchView));
  });
  root.querySelector("[data-create-view]")?.addEventListener("click", (e) => {
    e.stopPropagation();
    createView();
  });

  const infoBtn = root.querySelector("[data-views-info-toggle]");
  const callout = root.querySelector("[data-views-callout]");
  const openCallout = () => {
    calloutOpen = true;
    positionCallout(infoBtn, root, callout);
    callout.classList.add("show");
    infoBtn.setAttribute("aria-expanded", "true");
  };
  const closeCallout = () => {
    calloutOpen = false;
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
  // calloutOpen true means this render is a rebuild while it was showing — reopen (repositions too)
  if (infoBtn && callout && (calloutOpen || !localStorage.getItem(VIEWS_INFO_SEEN_KEY))) openCallout();

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
        message: "This only removes the saved layout — it doesn't touch any sessions.",
        confirmLabel: "Delete",
        danger: true,
      });
      if (!ok) return;
      // if you're currently viewing the one being deleted, route back to All Projects (URL + render)
      if (activeView === `saved:${id}`) await switchToView("group");
      await deleteSavedView(id);
      await import("./renderSidebar.js").then((m) => m.renderSidebar());
    });
  });
}
