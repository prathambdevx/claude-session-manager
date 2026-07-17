// "Quick Prompt" — hand a session a task without opening a terminal yourself. The backend picks
// one of two delivery paths per request (see routes/quickPrompts.ts): if that session's terminal
// is already open, the prompt is typed straight into it (response has no jobId — nothing to track,
// it's a real terminal now); otherwise it resumes that session's transcript in the background and
// returns a jobId whose running/done/error state rides the normal /api/sessions poll, same as
// delegations.
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
