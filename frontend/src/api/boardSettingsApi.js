// Small board-level display preferences — server-side so they're shared across browsers, not
// stuck in one browser's localStorage.
import { setAutoHideEmpty } from "../state.js";

export function applyBoardSettings(settings) {
  setAutoHideEmpty(Boolean(settings?.autoHideEmpty));
}

export async function saveAutoHideEmpty(value) {
  setAutoHideEmpty(value);
  await fetch("/api/board-settings", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ autoHideEmpty: value }),
  });
}
