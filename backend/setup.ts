// One-command setup: installs a launchd user agent so the server starts on login and auto-restarts
// if it dies — using THIS machine's real paths (no hardcoding). Idempotent; also migrates/replaces
// any previous agent. Run:  bun run setup   (uninstall:  bun run setup -- --uninstall)
import { join } from "node:path";
import { homedir } from "node:os";
import { existsSync } from "node:fs";
import { writeFile, unlink, mkdir } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { LAUNCHD_LABEL } from "./src/constants.ts";


const LABEL = LAUNCHD_LABEL;
const LEGACY_LABELS = ["com.pratham.claude-sessions"]; // older hand-installed labels to clean up
const HOME = homedir();
const ROOT = import.meta.dir; // this repo's folder
const AGENTS_DIR = join(HOME, "Library", "LaunchAgents");
const PLIST_PATH = join(AGENTS_DIR, `${LABEL}.plist`);
const LOG_PATH = join(ROOT, "launchd.log");
const GHOSTTY_APP = "/Applications/Ghostty.app";

type ServerPermissions = { accessibility: boolean; ghosttyAutomation: boolean };

async function fetchServerPermissions(): Promise<ServerPermissions | null> {
  try {
    const res = await fetch("http://127.0.0.1:4321/api/permissions");
    if (res.ok) return await res.json();
  } catch {
    // server may not be accepting connections yet
  }
  return null;
}

// Asks the REAL running server (not this interactive script) whether it has Accessibility/
// Automation access — see routes/permissions.ts for why that distinction matters. Retries briefly
// since the server has only just started.
async function fetchServerPermissionsWithRetry(): Promise<ServerPermissions | null> {
  for (let i = 0; i < 10; i++) {
    const perms = await fetchServerPermissions();
    if (perms) return perms;
    await Bun.sleep(300);
  }
  return null;
}

// Opens one Privacy pane and blocks until that specific grant flips true (or a timeout) — the two
// panes MUST be handled one at a time because System Settings is single-window, so opening both at
// once just makes the second instantly replace the first.
async function openAndAwaitGrant(pane: string, key: keyof ServerPermissions, missingMsg: string): Promise<void> {
  console.log(missingMsg);
  spawnSync("open", [`x-apple.systempreferences:com.apple.preference.security?Privacy_${pane}`], { stdio: "ignore" });
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    await Bun.sleep(1500);
    const perms = await fetchServerPermissions();
    if (perms?.[key]) {
      console.log("  ✓ granted.");
      return;
    }
  }
  console.log("  (not granted yet — grant it whenever you like; it takes effect on the next launch.)");
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

  const perms = await fetchServerPermissionsWithRetry();
  if (!perms) {
    console.log("⚠ Couldn't reach the server yet to check permissions — run `bun run setup` again in a few seconds.");
  } else {
    if (perms.accessibility) {
      console.log("✓ Accessibility permission for \"bun\" already granted.");
    } else {
      await openAndAwaitGrant("Accessibility", "accessibility", "⚠ Grant Accessibility to \"bun\" and \"Ghostty\" in the window that just opened.");
    }
    if (perms.ghosttyAutomation) {
      console.log("✓ Automation permission for \"bun\" already granted.");
    } else {
      await openAndAwaitGrant("Automation", "ghosttyAutomation", "⚠ Grant Automation to \"bun\" and \"Ghostty\" in the window that just opened.");
    }
  }

  console.log("\nIt's running now and will start automatically on every login/reboot.");
  console.log(
    "Make sure \"bun\" and \"Ghostty\" are both checked on in System Settings → Privacy & Security → " +
      "Accessibility and → Automation — Resume session won't work properly without it."
  );
  console.log("Open: http://127.0.0.1:4321");
}

if (process.argv.includes("--uninstall")) {
  await uninstall();
} else {
  await install();
}
