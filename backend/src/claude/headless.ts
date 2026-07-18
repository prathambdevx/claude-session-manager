// One-shot, awaited headless `claude` calls — used for quick synchronous tasks like summarizing a
// session or running a smart search query.
import { spawn } from "node:child_process";
import { CLAUDE_BIN, HOME } from "../constants.ts";

export function runClaudeHeadless(
  prompt: string,
  opts: { timeoutMs?: number; cwd?: string; model?: string; disallowedTools?: string; tools?: string } = {}
): Promise<string> {
  const { timeoutMs = 30000, cwd = HOME, model = "claude-haiku-4-5-20251001", disallowedTools, tools } = opts;
  return new Promise((resolve, reject) => {
    const args = ["-p", prompt, "--model", model, "--no-session-persistence"];
    if (disallowedTools) args.push("--disallowedTools", disallowedTools);
    if (tools !== undefined) args.push("--tools", tools);
    const child = spawn(CLAUDE_BIN, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("headless run timed out"));
    }, timeoutMs);
    child.stdout.on("data", (d) => (out += d.toString()));
    child.stderr.on("data", (d) => (err += d.toString()));
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(out.trim());
      else reject(new Error(err.trim() || `claude exited ${code}`));
    });
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
  });
}
