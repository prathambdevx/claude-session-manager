// Older `claude` CLI installs don't recognize --effort — probed once at process startup so this
// app never passes a flag that would otherwise abort every single invocation with
// "error: unknown option '--effort'" on those installs.
import { spawn } from "node:child_process";
import { CLAUDE_BIN } from "../constants.ts";

function probeEffortSupport(): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn(CLAUDE_BIN, ["--help"], { stdio: ["ignore", "pipe", "ignore"] });
    let out = "";
    child.stdout.on("data", (d) => (out += d.toString()));
    child.on("close", () => resolve(out.includes("--effort")));
    child.on("error", () => resolve(false));
  });
}

export const SUPPORTS_EFFORT = await probeEffortSupport();
