// Whenever the maintainer pushes to main, this pulls those changes onto every machine already
// running the app — no one has to remember to re-run the install command or type `git pull`
// themselves. Polls the remote's HEAD sha, fast-forwards if it moved, then kicks the launchd agent
// so the new code actually takes effect (RunAtLoad/KeepAlive in the plist bring it straight back).
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { hostname } from "node:os";
import { ROOT, LAUNCHD_LABEL, INSTALL_LOG_URL } from "../constants.ts";

function git(args: string[]): { status: number | null; stdout: string; stderr: string; missing: boolean } {
  const result = spawnSync("git", args, { cwd: ROOT, encoding: "utf-8" });
  return {
    status: result.status,
    stdout: (result.stdout || "").trim(),
    stderr: (result.stderr || "").trim(),
    // git absent from launchd's minimal PATH (no Xcode CLT, brew-only git) shows up as ENOENT here.
    missing: (result.error as NodeJS.ErrnoException | undefined)?.code === "ENOENT",
  };
}

// Best-effort usage ping — this is what lets the maintainer see already-installed machines
// checking in on every future auto-update, not just fresh bootstrap.sh runs. Never awaited/thrown
// from a caller — an offline machine just never logs that row.
function logInstallEvent(event: "install" | "auto-update" | "auto-update-failed", sha: string): void {
  const name = spawnSync("scutil", ["--get", "ComputerName"], { encoding: "utf-8" }).stdout?.trim() || hostname();
  const os = "macOS " + (spawnSync("sw_vers", ["-productVersion"], { encoding: "utf-8" }).stdout?.trim() || "unknown");
  const host = hostname().replace(/\.local$/, ""); // os.hostname() includes the mDNS .local suffix
  const params = new URLSearchParams({ event, name, host, os, sha });
  fetch(`${INSTALL_LOG_URL}?${params}`).catch(() => {});
}

// Remember what we've already reported so a machine stuck on the same cause logs once, not a fresh
// row every 5-minute tick — reset on the next success so a NEW failure (or the same one recurring
// after a working stretch) still gets its own row.
let lastLoggedRemoteFailure = "";
let lastLoggedPullFailureSha = "";

async function checkForUpdate(): Promise<void> {
  if (!existsSync(`${ROOT}/.git`)) return; // not a git checkout — nothing to pull

  const remote = git(["ls-remote", "origin", "main"]);
  if (remote.status !== 0 || !remote.stdout) {
    // Anything here — git missing, a proxy/firewall blocking outbound git from launchd's stripped
    // environment, DNS, etc. — otherwise fails dead silent forever, indistinguishable from the
    // machine simply being asleep. One row per distinct reason, not one per tick.
    const reason = remote.missing
      ? "git-not-found-on-PATH"
      : (remote.stderr || remote.stdout || "ls-remote failed").replace(/\s+/g, " ").slice(0, 80);
    if (reason !== lastLoggedRemoteFailure) {
      lastLoggedRemoteFailure = reason;
      logInstallEvent("auto-update-failed", reason);
    }
    return;
  }
  lastLoggedRemoteFailure = ""; // back to reachable — a future failure is a fresh cause, not a repeat
  const remoteSha = remote.stdout.split(/\s+/)[0];

  const local = git(["rev-parse", "HEAD"]);
  if (local.status !== 0 || local.stdout === remoteSha) return;

  console.log(`[auto-update] main moved to ${remoteSha.slice(0, 7)} — pulling...`);
  // --ff-only so a machine with real local changes is left untouched rather than silently merged.
  const pull = git(["pull", "--ff-only", "origin", "main"]);
  if (pull.status !== 0) {
    const reason = (pull.stderr || pull.stdout || "pull --ff-only failed").replace(/\s+/g, " ").slice(0, 80);
    console.log("[auto-update] pull failed — skipping:", reason);
    if (remoteSha !== lastLoggedPullFailureSha) {
      lastLoggedPullFailureSha = remoteSha;
      logInstallEvent("auto-update-failed", `${remoteSha.slice(0, 7)} ${reason}`);
    }
    return;
  }

  console.log("[auto-update] pulled — restarting to pick up the new code.");
  logInstallEvent("auto-update", remoteSha.slice(0, 7));
  spawnSync("launchctl", ["kickstart", "-k", `gui/${process.getuid?.()}/${LAUNCHD_LABEL}`], { stdio: "ignore" });
}

let started = false;
export function startAutoUpdater(intervalMs = 5 * 60 * 1000): void {
  if (started) return; // idempotent — tests may import routes more than once
  started = true;
  setInterval(() => {
    checkForUpdate().catch(() => {}); // best-effort; a transient failure just waits for the next tick
  }, intervalMs);
}
