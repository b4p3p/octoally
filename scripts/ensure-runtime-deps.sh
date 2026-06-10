#!/usr/bin/env bash
# Ensure OctoAlly's system runtime dependencies are installed.
#
# Mirrors the prerequisite step of scripts/install.sh so a dev environment set
# up from source (deploy-dev.sh / dev-setup.sh) matches what an end-user gets.
# install.sh keeps its own inline copy because it runs standalone (curl | bash,
# with no repo checkout to source this file from).
#
# Idempotent: only installs what's missing. Safe to run repeatedly.
#
# Usage: bash scripts/ensure-runtime-deps.sh

set -euo pipefail

CYAN='\033[0;36m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; NC='\033[0m'
log()  { echo -e "${CYAN}[deps]${NC} $1"; }
ok()   { echo -e "${GREEN}[deps]${NC} $1"; }
warn() { echo -e "${YELLOW}[deps]${NC} $1"; }

OS="$(uname -s)"

SUDO=""
if [ "$(id -u)" -ne 0 ] && command -v sudo >/dev/null 2>&1; then
  SUDO="sudo"
fi

# tmux + dtach give persistent sessions (survive server restarts); without them
# the server falls back to direct mode and sessions die on restart.
NEEDED=()
command -v tmux  >/dev/null 2>&1 || NEEDED+=(tmux)
command -v dtach >/dev/null 2>&1 || NEEDED+=(dtach)
command -v curl  >/dev/null 2>&1 || NEEDED+=(curl)

case "$OS" in
  Linux*)
    # build tools for native node modules (better-sqlite3, node-pty)
    command -v make >/dev/null 2>&1 || NEEDED+=(build-essential)
    command -v g++  >/dev/null 2>&1 || NEEDED+=(build-essential)
    if [ ${#NEEDED[@]} -eq 0 ]; then
      ok "system runtime deps already present (tmux, dtach, curl, build tools)"
      exit 0
    fi
    # Deduplicate
    NEEDED=($(printf '%s\n' "${NEEDED[@]}" | sort -u))
    log "installing: ${NEEDED[*]}"
    $SUDO apt-get update -qq
    $SUDO apt-get install -y -qq "${NEEDED[@]}"
    ok "installed: ${NEEDED[*]}"
    ;;
  Darwin*)
    if [ ${#NEEDED[@]} -eq 0 ]; then
      ok "system runtime deps already present (tmux, dtach, curl)"
      exit 0
    fi
    if command -v brew >/dev/null 2>&1; then
      log "installing: ${NEEDED[*]}"
      brew install "${NEEDED[@]}" 2>&1 || true
      ok "installed (or already present): ${NEEDED[*]}"
    else
      warn "Homebrew not found — install manually: ${NEEDED[*]}"
      exit 1
    fi
    ;;
  *)
    warn "unsupported OS ($OS) — install manually: ${NEEDED[*]:-none}"
    ;;
esac
