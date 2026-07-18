// Small board-level display preferences — server-side so they're shared across browsers, not
// stuck in one browser's localStorage.
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
