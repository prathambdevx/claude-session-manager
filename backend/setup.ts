// One-command setup: installs a launchd user agent so the server starts on login and auto-restarts
// if it dies — using THIS machine's real paths (no hardcoding). Idempotent; also migrates/replaces
// any previous agent. Run:  bun run setup   (uninstall:  bun run setup -- --uninstall)
import { join } from "node:path";
import { homedir } from "node:os";
import { existsSync } from "node:fs";
import { writeFile, unlink, mkdir } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { LAUNCHD_LABEL } from "./src/constants.ts";
import { ensureCsmCli } from "./src/csmCli.ts";
import { detectTerminalFromEnv, saveTerminalConfig } from "./src/claude/index.ts";


const LABEL = LAUNCHD_LABEL;
const LEGACY_LABELS = ["com.pratham.claude-sessions"]; // older hand-installed labels to clean up
const HOME = homedir();
const ROOT = import.meta.dir; // this repo's folder
const AGENTS_DIR = join(HOME, "Library", "LaunchAgents");
const PLIST_PATH = join(AGENTS_DIR, `${LABEL}.plist`);
const LOG_PATH = join(ROOT, "launchd.log");

// tmux is a small headless CLI (not an app the user adopts), so terminal features depend on it
// being on PATH. Best-effort: if Homebrew is missing or the install fails, the dashboard still runs
// but launches/quick-prompts read-only-banner instead of crashing — see routes/sessions.ts.
async function ensureTmux(): Promise<boolean> {
  const already = spawnSync("which", ["tmux"], { encoding: "utf-8" });
  if (already.status === 0 && already.stdout.trim()) {
    console.log("✓ tmux already installed — sessions will run in it.");
    return true;
  }
  const brew = spawnSync("which", ["brew"], { encoding: "utf-8" });
  if (brew.status !== 0 || !brew.stdout.trim()) {
    console.log(
      "⚠ tmux isn't installed and Homebrew isn't available — skipping. " +
        "Install it yourself (`brew install tmux`) to launch and manage terminals; the dashboard will run read-only until then."
    );
    return false;
  }
  console.log("Installing tmux (brew install tmux)...");
  const install = spawnSync("brew", ["install", "tmux"], { stdio: "inherit" });
  const check = spawnSync("which", ["tmux"], { encoding: "utf-8" });
  if (install.status !== 0 || check.status !== 0 || !check.stdout.trim()) {
    console.log("⚠ tmux install failed — the dashboard will run read-only. Retry later with: brew install tmux");
    return false;
  }
  console.log("✓ tmux installed — sessions will now run in it.");
  return true;
}

function bootout(label: string, path: string) {
  // works across macOS versions; ignore errors when the agent isn't loaded
  spawnSync("launchctl", ["bootout", `gui/${process.getuid?.()}/${label}`], { stdio: "ignore" });
  spawnSync("launchctl", ["unload", path], { stdio: "ignore" });
}

async function uninstall() {
  bootout(LABEL, PLIST_PATH);
  if (existsSync(PLIST_PATH)) await unlink(PLIST_PATH);
  console.log("✓ Uninstalled — the auto-start agent is removed. (Your data/ is untouched.)");
}

async function install() {
  const tmuxOk = await ensureTmux();

  // persisted so a launchd-run server (no TERM_PROGRAM of its own) still knows which terminal app
  // to launch/focus — see terminalLauncher.ts's resolveTerminalApp fallback chain
  const detected = detectTerminalFromEnv();
  if (detected) {
    saveTerminalConfig(detected);
    console.log(`✓ Detected terminal: ${detected} (saved to data/terminal.json).`);
  } else {
    console.log("⚠ Couldn't detect your terminal app from this shell — falling back to Apple Terminal. Set CSM_TERMINAL to override.");
  }

  // resolve the bun binary running this script; fall back to `which bun`
  let bun = process.execPath;
  if (!bun || !bun.includes("bun")) {
    const which = spawnSync("which", ["bun"], { encoding: "utf-8" });
    bun = which.stdout.trim() || "/opt/homebrew/bin/bun";
  }

  await mkdir(AGENTS_DIR, { recursive: true });

  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${bun}</string>
    <string>run</string>
    <string>server.ts</string>
  </array>
  <key>WorkingDirectory</key>
  <string>${ROOT}</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${LOG_PATH}</string>
  <key>StandardErrorPath</key>
  <string>${LOG_PATH}</string>
</dict>
</plist>
`;

  // clean up any previous agent (this label + legacy hand-installed ones) to avoid port conflicts.
  // legacy plist FILES must be deleted too, not just booted out — LaunchAgents auto-load at login,
  // so a lingering file would relaunch a conflicting server on the next reboot.
  bootout(LABEL, PLIST_PATH);
  for (const legacy of LEGACY_LABELS) {
    const legacyPath = join(AGENTS_DIR, `${legacy}.plist`);
    bootout(legacy, legacyPath);
    if (existsSync(legacyPath)) await unlink(legacyPath);
  }

  await writeFile(PLIST_PATH, plist);
  const load = spawnSync("launchctl", ["load", PLIST_PATH], { encoding: "utf-8" });
  if (load.status !== 0) {
    console.error("✗ launchctl load failed:", load.stderr || load.stdout);
    process.exit(1);
  }

  console.log("✓ Installed and started.");
  console.log(`  bun:     ${bun}`);
  console.log(`  folder:  ${ROOT}`);
  console.log(`  logs:    ${LOG_PATH}`);

  ensureCsmCli();

  console.log("\nIt's running now and will start automatically on every login/reboot.");
  if (!tmuxOk) {
    console.log("⚠ Install tmux to launch and manage terminals: `brew install tmux` (then restart: bun run restart).");
  }
  console.log("Open: http://127.0.0.1:4321");
}

if (process.argv.includes("--uninstall")) {
  await uninstall();
} else {
  await install();
}
