// CRUD for saved board views — named, reusable snapshots of Main board's column layout,
// switchable from the sidebar without disturbing the live Main board.
import { savedViews, setSavedViews, boardColumns } from "../state.js";
import { toast } from "../ui/toast.js";

export async function createSavedView(title) {
  const res = await fetch("/api/saved-views", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title, columns: boardColumns }),
  });
  const data = await res.json();
  if (data.ok) {
    setSavedViews([...savedViews, data.view]);
    toast(`Saved "${data.view.title}" — the sidebar remembers this exact column set`);
  } else {
    toast("Failed to save view: " + (data.error || "unknown error"));
  }
  return data;
}

export async function renameSavedView(id, title) {
  const res = await fetch(`/api/saved-views/${id}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title }),
  });
  const data = await res.json();
  if (data.ok) setSavedViews(savedViews.map((v) => (v.id === id ? data.view : v)));
  return data;
}

export async function saveSavedViewColumns(id, columns) {
  const res = await fetch(`/api/saved-views/${id}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ columns }),
  });
  const data = await res.json();
  if (data.ok) setSavedViews(savedViews.map((v) => (v.id === id ? data.view : v)));
  return data;
}

export async function deleteSavedView(id) {
  await fetch(`/api/saved-views/${id}`, { method: "DELETE" });
  setSavedViews(savedViews.filter((v) => v.id !== id));
  toast("View deleted");
}
