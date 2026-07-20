// Whenever the maintainer pushes to main, this pulls those changes onto every machine already
// running the app — no one has to remember to re-run the install command or type `git pull`
// themselves. Polls the remote's HEAD sha, fast-forwards if it moved, then kicks the launchd agent
// so the new code actually takes effect (RunAtLoad/KeepAlive in the plist bring it straight back).
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { ROOT, LAUNCHD_LABEL } from "../constants.ts";

function git(args: string[]): { status: number | null; stdout: string } {
  const result = spawnSync("git", args, { cwd: ROOT, encoding: "utf-8" });
  return { status: result.status, stdout: (result.stdout || "").trim() };
}

async function checkForUpdate(): Promise<void> {
  if (!existsSync(`${ROOT}/.git`)) return; // not a git checkout — nothing to pull

  const remote = git(["ls-remote", "origin", "main"]);
  if (remote.status !== 0 || !remote.stdout) return; // offline/unreachable — just try again next tick
  const remoteSha = remote.stdout.split(/\s+/)[0];

  const local = git(["rev-parse", "HEAD"]);
  if (local.status !== 0 || local.stdout === remoteSha) return;

  console.log(`[auto-update] main moved to ${remoteSha.slice(0, 7)} — pulling...`);
  // --ff-only so a machine with real local changes is left untouched rather than silently merged.
  const pull = git(["pull", "--ff-only", "origin", "main"]);
  if (pull.status !== 0) {
    console.log("[auto-update] pull failed (local changes on this machine?) — skipping:", pull.stdout);
    return;
  }

  console.log("[auto-update] pulled — restarting to pick up the new code.");
  spawnSync("launchctl", ["kickstart", "-k", `gui/${process.getuid?.()}/${LAUNCHD_LABEL}`], { stdio: "ignore" });
}

let started = false;
export function startAutoUpdater(intervalMs = 60 * 60 * 1000): void {
  if (started) return; // idempotent — tests may import routes more than once
  started = true;
  setInterval(() => {
    checkForUpdate().catch(() => {}); // best-effort; a transient failure just waits for the next tick
  }, intervalMs);
}
