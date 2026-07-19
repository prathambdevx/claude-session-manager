// Quick Prompt: hand a session a task without opening a terminal — backend picks terminal-delivery
// or background-resume per request (see routes/quickPrompts.ts).
import { toast } from "../ui/toast.js";
import { quickPrompts } from "../state.js";

export async function sendQuickPrompt(sessionId, prompt) {
  const res = await fetch("/api/quickprompts", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sessionId, prompt }),
  });
  const data = await res.json();
  if (!data.ok) {
    toast("Failed to send: " + (data.error || "unknown error"));
  } else if (data.deliveredTo === "terminal") {
    toast("Sent to the open terminal");
  } else {
    toast("Sent to background — no terminal opened");
  }
  return data;
}

// Only the newest job per session is ever shown (see boardCard.js's jobChipHtml), so dismissing it
// must clear every older finished job for that session too — otherwise the next-newest one
// reappears as if it were new, forcing repeated dismiss clicks for jobs that were never shown.
export async function dismissQuickPrompt(sessionId) {
  const jobs = quickPrompts.filter((j) => j.sessionId === sessionId && j.status !== "running");
  await Promise.all(jobs.map((j) => fetch(`/api/quickprompts/${j.id}`, { method: "DELETE" })));
}
