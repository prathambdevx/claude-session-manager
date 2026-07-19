// One-command setup: installs a launchd user agent so the server starts on login and auto-restarts
// if it dies — using THIS machine's real paths (no hardcoding). Idempotent; also migrates/replaces
// any previous agent. Run:  bun run setup   (uninstall:  bun run setup -- --uninstall)
import { join } from "node:path";
import { homedir } from "node:os";
import { existsSync } from "node:fs";
import { writeFile, unlink, mkdir } from "node:fs/promises";
import { spawnSync } from "node:child_process";


const LABEL = "com.claude-session-manager";
const LEGACY_LABELS = ["com.pratham.claude-sessions"]; // older hand-installed labels to clean up
const HOME = homedir();
const ROOT = import.meta.dir; // this repo's folder
const AGENTS_DIR = join(HOME, "Library", "LaunchAgents");
const PLIST_PATH = join(AGENTS_DIR, `${LABEL}.plist`);
const LOG_PATH = join(ROOT, "launchd.log");
const GHOSTTY_APP = "/Applications/Ghostty.app";

// Focusing an existing window and auto-tiling both need Accessibility access via System Events —
// macOS can't auto-prompt for it once the server runs as a launchd background daemon (no attached
// UI session), so it fails silently forever unless granted up front. Checked here, interactively,
// instead. Best-effort, like ensureGhostty below: never blocks setup either way.
function hasAccessibilityAccess(): boolean {
  const result = spawnSync("osascript", ["-e", 'tell application "System Events" to UI elements enabled'], { encoding: "utf-8" });
  return result.stdout.trim() === "true";
}

// Returns true if this permission is missing, so the caller knows whether to open Settings and
// print the reminder below.
function ensureAccessibilityAccess(): boolean {
  if (hasAccessibilityAccess()) {
    console.log("✓ Accessibility permission for \"bun\" already granted.");
    return false;
  }
  spawnSync("open", ["x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility"], { stdio: "ignore" });
  return true;
}

// Separate TCC category from Accessibility above — this is what governs `tell application
// "Ghostty" to ...` commands (launching windows, auto-tiling's own script). Launches Ghostty as a
// side effect if it isn't already running.
function hasGhosttyAutomationAccess(): boolean {
  const result = spawnSync("osascript", ["-e", 'tell application "Ghostty" to count windows'], { encoding: "utf-8" });
  return result.status === 0;
}

function ensureGhosttyAutomationAccess(): boolean {
  if (hasGhosttyAutomationAccess()) {
    console.log("✓ Automation permission for \"bun\" and \"Ghostty\" already granted.");
    return false;
  }
  spawnSync("open", ["x-apple.systempreferences:com.apple.preference.security?Privacy_Automation"], { stdio: "ignore" });
  return true;
}

// Sessions launch in Ghostty when it's installed (src/claude.ts prefers it over Apple Terminal), so
// setup installs it via Homebrew if it isn't already there. Best-effort: if Homebrew is missing or
// the install fails, launches just fall back to Apple Terminal — never blocks the rest of setup.
async function ensureGhostty() {
  if (existsSync(GHOSTTY_APP)) {
    console.log("✓ Ghostty already installed — sessions will launch in it.");
    return;
  }
  const brew = spawnSync("which", ["brew"], { encoding: "utf-8" });
  if (brew.status !== 0 || !brew.stdout.trim()) {
    console.log(
      "⚠ Ghostty isn't installed and Homebrew isn't available — skipping. " +
        "Install it yourself (https://ghostty.org) to get sessions launching in it; falling back to Apple Terminal for now."
    );
    return;
  }
  console.log("Installing Ghostty (brew install --cask ghostty)...");
  const install = spawnSync("brew", ["install", "--cask", "ghostty"], { stdio: "inherit" });
  if (install.status !== 0 || !existsSync(GHOSTTY_APP)) {
    console.log("⚠ Ghostty install failed — falling back to Apple Terminal. Retry later with: brew install --cask ghostty");
    return;
  }
  console.log("✓ Ghostty installed — sessions will now launch in it.");
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
  await ensureGhostty();
  const accessibilityWarned = ensureAccessibilityAccess();
  const automationWarned = ensureGhosttyAutomationAccess();
  // one simple line covers both — give a real few seconds to actually read it before the rest of
  // setup's own output scrolls it away.
  if (accessibilityWarned || automationWarned) {
    console.log("⚠ Please grant permission for Ghostty and bun in the System Settings window that just opened.");
    await Bun.sleep(5000);
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
  console.log("\nIt's running now and will start automatically on every login/reboot.");
  console.log("Open: http://127.0.0.1:4321");
}

if (process.argv.includes("--uninstall")) {
  await uninstall();
} else {
  await install();
}
