#!/bin/bash
# Bootstraps a fresh Mac end to end: installs Bun if it's missing, clones this repo if you're not
# already sitting inside a copy of it, then runs the real setup (backend/setup.ts) — installing
# Ghostty, checking Accessibility access, and installing the launchd auto-start agent.
#
#   curl -fsSL https://raw.githubusercontent.com/prathambdevx/claude-session-manager/main/bootstrap.sh | bash
#
# Already cloned it yourself? cd into the repo and just run: bash bootstrap.sh
set -e

# Keep in sync with backend/src/constants.ts's INSTALL_LOG_URL — a bash script can't import a
# TypeScript constant, so this is duplicated by hand.
INSTALL_LOG_URL="https://script.google.com/macros/s/AKfycbx0CyTns0VGytsm_0vfQgBu6VO1czZ88b5Z9_rI0R368b72TcQTWsxDW7LWLa3-ZAJAXQ/exec"

# Silent usage ping — raw.githubusercontent.com fetches aren't tracked by GitHub's own traffic API,
# so this is the only way to know how many machines have run this script. Backgrounded, output
# discarded, and never allowed to fail/block the real setup below.
log_install_event() {
  local name host os sha
  name=$(scutil --get ComputerName 2>/dev/null || hostname)
  host=$(hostname -s 2>/dev/null || hostname) # -s strips the .local mDNS suffix
  os="macOS $(sw_vers -productVersion 2>/dev/null || echo unknown)"
  sha=$(git rev-parse --short HEAD 2>/dev/null || echo "")
  (curl -fsSL -G "$INSTALL_LOG_URL" \
    --data-urlencode "event=install" \
    --data-urlencode "name=$name" \
    --data-urlencode "host=$host" \
    --data-urlencode "os=$os" \
    --data-urlencode "sha=$sha" \
    >/dev/null 2>&1 &) >/dev/null 2>&1
}

if ! command -v bun &>/dev/null; then
  echo "Bun not found — installing (https://bun.sh)..."
  curl -fsSL https://bun.sh/install | bash
  # the installer only updates .zshrc/.bashrc for FUTURE shells — pick it up now too
  export BUN_INSTALL="$HOME/.bun"
  export PATH="$BUN_INSTALL/bin:$PATH"
fi

if [ ! -f "backend/setup.ts" ]; then
  REPO_DIR="$HOME/tools/claude-sessions"
  if [ ! -d "$REPO_DIR/.git" ]; then
    echo "Cloning claude-session-manager into $REPO_DIR..."
    git clone https://github.com/prathambdevx/claude-session-manager.git "$REPO_DIR"
  fi
  cd "$REPO_DIR"
fi

# Every run pulls latest — whether we just cloned/cd'ed above or the caller was already sitting
# inside their own checkout (the "cd into the repo and run bash bootstrap.sh" path from the header
# comment, which used to skip this entirely and silently reinstall whatever stale code was on disk).
# --ff-only so this never overwrites real local changes; falls through to use it as-is if not.
if [ -d ".git" ]; then
  echo "Pulling latest changes..."
  git pull --ff-only origin main || echo "⚠ Couldn't update (local changes?) — using it as-is."
fi

log_install_event

bun run setup
