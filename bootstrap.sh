#!/bin/bash
# Bootstraps a fresh Mac end to end: installs Bun if it's missing, clones this repo if you're not
# already sitting inside a copy of it, then runs the real setup (backend/setup.ts) — installing
# Ghostty, checking Accessibility access, and installing the launchd auto-start agent.
#
#   curl -fsSL https://raw.githubusercontent.com/prathambdevx/claude-session-manager/main/bootstrap.sh | bash
#
# Already cloned it yourself? cd into the repo and just run: bash bootstrap.sh
set -e

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

bun run setup
