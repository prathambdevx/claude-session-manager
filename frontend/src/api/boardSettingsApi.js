// Small board-level display preferences (default view, auto-hide-empty-columns) — server-side so
// they're shared across browsers, like everything else here, instead of stuck in one browser's
// localStorage.
import { setDefaultViewId, setAutoHideEmpty } from "../state.js";

export function applyBoardSettings(settings) {
  if (settings?.defaultViewId) setDefaultViewId(settings.defaultViewId);
  setAutoHideEmpty(Boolean(settings?.autoHideEmpty));
}

export async function saveDefaultViewId(id) {
  setDefaultViewId(id);
  await fetch("/api/board-settings", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ defaultViewId: id }),
  });
}

export async function saveAutoHideEmpty(value) {
  setAutoHideEmpty(value);
  await fetch("/api/board-settings", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ autoHideEmpty: value }),
  });
}
