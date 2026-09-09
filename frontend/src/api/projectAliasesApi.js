import { toast } from "../ui/toast.js";

export async function relocateProject(oldPath, newPath) {
  const res = await fetch("/api/project-aliases", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ oldPath, newPath }),
  });
  const data = await res.json();
  toast(data.ok ? "Project relocated — its sessions will reappear on the next refresh" : data.error || "Couldn't relocate project");
  return data;
}
