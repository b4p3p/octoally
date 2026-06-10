#!/usr/bin/env bash
# One-shot developer bootstrap: prepare this machine to work on OctoAlly from
# source. Idempotent — safe to run repeatedly.
#
#   1. system runtime deps (tmux, dtach, build tools)  -> ensure-runtime-deps.sh
#   2. npm dependencies for root + server + dashboard   -> install:all
#
# After this, run an isolated dev environment that NEVER touches the installed
# app's port or database:
#
#   npm run dev:isolated
#       server   -> http://localhost:42020   (DB: ~/.octoally/octoally-dev.db)
#       dashboard-> http://localhost:42021   (proxies to the dev server)
#
# Usage: bash scripts/dev-setup.sh   (or: npm run dev:setup)

set -euo pipefail

SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

GREEN='\033[0;32m'; CYAN='\033[0;36m'; BOLD='\033[1m'; NC='\033[0m'
log() { echo -e "${CYAN}[dev-setup]${NC} $1"; }
ok()  { echo -e "${GREEN}[dev-setup]${NC} $1"; }

# 1. System runtime deps (same set install.sh gives end-users)
log "Ensuring system runtime dependencies..."
bash "$SRC_DIR/scripts/ensure-runtime-deps.sh"

# 2. npm dependencies (root + server + dashboard)
log "Installing npm dependencies (root + server + dashboard)..."
cd "$SRC_DIR"
npm run install:all

ok "Dev environment ready."
echo ""
echo -e "  ${BOLD}Start an isolated dev environment (never touches the installed app):${NC}"
echo "    npm run dev:isolated"
echo ""
echo -e "    server    -> http://localhost:42020   (DB: ~/.octoally/octoally-dev.db)"
echo -e "    dashboard -> http://localhost:42021"
echo ""
echo -e "  ${BOLD}Deploy from source to the local install:${NC}"
echo "    npm run deploy"
echo ""
