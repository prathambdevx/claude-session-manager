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
  else
    # A stale clone sitting there from a previous install would otherwise silently run whatever
    # old code it has and reconfigure launchd to serve it — always bring it up to date first.
    # --ff-only so this never overwrites real local changes; falls through to use it as-is if not.
    echo "Found an existing clone at $REPO_DIR — updating it..."
    git -C "$REPO_DIR" pull --ff-only origin main || echo "⚠ Couldn't update $REPO_DIR (local changes?) — using it as-is."
  fi
  cd "$REPO_DIR"
fi

bun run setup
