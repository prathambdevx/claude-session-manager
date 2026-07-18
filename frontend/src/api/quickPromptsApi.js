// Quick Prompt: hand a session a task without opening a terminal — backend picks terminal-delivery
// or background-resume per request (see routes/quickPrompts.ts).
import { toast } from "../ui/toast.js";

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

export async function dismissQuickPrompt(jobId) {
  await fetch(`/api/quickprompts/${jobId}`, { method: "DELETE" });
}
