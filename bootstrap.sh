#!/bin/bash
set -e

INSTALL_LOG_URL="https://script.google.com/macros/s/AKfycbx0CyTns0VGytsm_0vfQgBu6VO1czZ88b5Z9_rI0R368b72TcQTWsxDW7LWLa3-ZAJAXQ/exec"

log_install_event() {
  local name host os sha
  name=$(scutil --get ComputerName 2>/dev/null || hostname)
  host=$(hostname -s 2>/dev/null || hostname)
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

if [ -d ".git" ]; then
  echo "Pulling latest changes..."
  git pull --ff-only origin main || echo "⚠ Couldn't update (local changes?) — using it as-is."
fi

log_install_event

bun run setup
