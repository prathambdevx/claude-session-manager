// Installs a tiny `csm` command into ~/.local/bin — the same directory the official claude
// installer already adds to PATH, so it resolves in any real terminal (Terminal.app, Ghostty,
// VSCode) without touching shell profile files ourselves. `csm --update` is a manual escape hatch
// that does exactly what the background auto-updater does (pull + restart), for machines where
// polling isn't running or is silently stuck — see docs/local-qa-and-testing.md.
import { existsSync } from "node:fs";
import { mkdirSync, writeFileSync, chmodSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { HOME, ROOT, LAUNCHD_LABEL } from "./constants.ts";

const CSM_BIN_PATH = join(HOME, ".local", "bin", "csm");

function scriptContents(): string {
  return `#!/bin/bash
set -e
REPO=${JSON.stringify(ROOT)}
LABEL=${JSON.stringify(LAUNCHD_LABEL)}

case "$1" in
  --update|update) ;;
  *) echo "Usage: csm --update"; exit 1 ;;
esac

if [ ! -d "$REPO/.git" ]; then
  echo "csm: expected a git checkout at $REPO but didn't find one."
  exit 1
fi

echo "Claude Session Manager is updating..."
BEFORE=$(git -C "$REPO" rev-parse HEAD 2>/dev/null)
LOG=$(mktemp)
if ! git -C "$REPO" pull --ff-only origin main >"$LOG" 2>&1; then
  echo "csm: update failed — you may have local changes there, or be offline (details: $LOG)."
  exit 1
fi

if [ "$(git -C "$REPO" rev-parse HEAD)" = "$BEFORE" ]; then
  echo "Already updated."
else
  launchctl kickstart -k "gui/$(id -u)/$LABEL" 2>/dev/null || true
  echo "Updated to $(git -C "$REPO" rev-parse --short HEAD) — restarted."
fi
`;
}

// Idempotent and cheap — safe to call on every server start (including the restart an auto-update
// itself triggers), so an already-installed machine gets/updates this command with zero extra
// steps the next time it happens to restart for any reason.
export function ensureCsmCli(): void {
  if (process.platform !== "darwin") return;
  const desired = scriptContents();
  const existing = existsSync(CSM_BIN_PATH) ? readFileSync(CSM_BIN_PATH, "utf-8") : null;
  if (existing === desired) return;
  mkdirSync(join(HOME, ".local", "bin"), { recursive: true });
  writeFileSync(CSM_BIN_PATH, desired);
  chmodSync(CSM_BIN_PATH, 0o755);
  console.log(`[csm-cli] ${existing ? "updated" : "installed"} \`csm --update\` at ${CSM_BIN_PATH}`);
}
