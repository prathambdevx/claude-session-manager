// CRUD for saved views — named, independent column layouts switchable from the sidebar.
import { savedViews, setSavedViews } from "../state.js";
import { toast } from "../ui/toast.js";

export async function createSavedView(title, columns) {
  const res = await fetch("/api/saved-views", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title, columns }),
  });
  const data = await res.json();
  if (data.ok) {
    setSavedViews([...savedViews, data.view]);
    await import("../components/sidebar/renderSidebar.js").then((m) => m.renderSidebar()); // show it in the sidebar without a reload
  } else {
    toast("Failed to create view: " + (data.error || "unknown error"));
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
