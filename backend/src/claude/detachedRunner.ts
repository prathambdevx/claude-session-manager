// Fire-and-forget background `claude` execution with a live streamed activity feed — the shared
// primitive behind both Delegations and Quick Prompt's background-resume path.
import { spawn } from "node:child_process";
import { CLAUDE_BIN, KNOWN_MODELS } from "../config.ts";
import { modelAliasWithContext } from "./prompts.ts";
import { activityLine } from "./activity.ts";

// Fire-and-forget spawn with a LIVE activity feed. Uses stream-json so we can parse each tool-use /
// reasoning event as it happens; onProgress is called (throttled) with the rolling activity log, and
// onClose fires once with the final result. Returns immediately (do NOT await).
export function runClaudeHeadlessDetached(
  prompt: string,
  opts: { cwd: string; model?: string | null; permission: "read-only" | "edit"; timeoutMs?: number; resumeSessionId?: string },
  callbacks: {
    onProgress: (activity: string[]) => void;
    onClose: (outcome: { ok: boolean; output: string; error: string | null }) => void;
  }
): number | null {
  const { cwd, model, permission, timeoutMs = 20 * 60 * 1000, resumeSessionId } = opts;
  const modelArg = model && KNOWN_MODELS.has(model) ? modelAliasWithContext(model) : null;
  // resumeSessionId continues that session's own transcript non-interactively (one turn, then
  // exits) instead of starting a disposable throwaway conversation — used by Quick Prompt, which
  // is meant to feel like "the same session did this in the background", not a fresh one-off.
  const args = resumeSessionId
    ? ["--resume", resumeSessionId, "-p", prompt, "--effort", "medium", "--output-format", "stream-json", "--verbose"]
    : ["-p", prompt, "--effort", "medium", "--no-session-persistence", "--output-format", "stream-json", "--verbose"];
  if (modelArg) args.push("--model", modelArg);
  if (permission === "read-only") args.push("--disallowedTools", "Edit,Write,NotebookEdit");
  else args.push("--dangerously-skip-permissions");

  let child;
  try {
    child = spawn(CLAUDE_BIN, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
  } catch (e: any) {
    callbacks.onClose({ ok: false, output: "", error: e?.message ?? "failed to spawn claude" });
    return null;
  }

  const MAX_ACTIVITY = 60;
  const activity: string[] = [];
  const assistantText: string[] = [];
  let finalResult: string | null = null;
  let err = "";
  let buf = ""; // line buffer — a JSON object can span multiple stdout chunks
  let lastFlush = 0;

  const flush = (force = false) => {
    const now = Date.now();
    if (force || now - lastFlush > 1500) {
      lastFlush = now;
      callbacks.onProgress(activity.slice(-MAX_ACTIVITY));
    }
  };

  const timer = setTimeout(() => child.kill(), timeoutMs);

  child.stdout?.on("data", (chunk) => {
    buf += chunk.toString();
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      let d: any;
      try {
        d = JSON.parse(line);
      } catch {
        continue;
      }
      if (d?.type === "result" && typeof d.result === "string") finalResult = d.result;
      if (d?.type === "assistant" && Array.isArray(d?.message?.content)) {
        for (const b of d.message.content) if (b?.type === "text" && b.text?.trim()) assistantText.push(b.text);
      }
      const line2 = activityLine(d);
      if (line2) {
        activity.push(line2);
        flush();
      }
    }
  });
  child.stderr?.on("data", (d) => (err += d.toString()));

  child.on("close", (code) => {
    clearTimeout(timer);
    flush(true);
    const output = (finalResult || assistantText.join("\n\n")).trim();
    if (code === 0) callbacks.onClose({ ok: true, output, error: null });
    else callbacks.onClose({ ok: false, output, error: err.trim() || `claude exited ${code}` });
  });
  child.on("error", (e) => {
    clearTimeout(timer);
    callbacks.onClose({ ok: false, output: "", error: e.message });
  });
  return child.pid ?? null;
}
