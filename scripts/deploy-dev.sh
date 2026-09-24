#!/usr/bin/env bash
# Deploy from source (progetti/octoally) to the local installation (~/octoally + /opt/OctoAlly)
# Usage: bash scripts/deploy-dev.sh

set -euo pipefail

SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
INSTALL_DIR="$HOME/octoally"
ELECTRON_ASAR="/opt/OctoAlly/resources/app.asar"

GREEN='\033[0;32m'
CYAN='\033[0;36m'
RED='\033[0;31m'
NC='\033[0m'

log_info()  { echo -e "${CYAN}[deploy]${NC} $1"; }
log_ok()    { echo -e "${GREEN}[deploy]${NC} $1"; }
log_error() { echo -e "${RED}[deploy]${NC} $1"; }

if [ ! -d "$INSTALL_DIR" ]; then
  log_error "Installation not found at $INSTALL_DIR"
  exit 1
fi

# 0. Ensure system runtime deps (tmux/dtach/build tools) so the dev install
#    matches what install.sh gives an end-user. Idempotent.
log_info "Checking system runtime dependencies..."
bash "$SRC_DIR/scripts/ensure-runtime-deps.sh"

# 1. Stop the running server, gracefully and through whoever owns it.
#    `fuser -k` used to be the first move, and it cost three live sessions:
#    SIGKILL on the main process makes systemd clean out the whole control
#    group, which takes tmux, the Claude processes and their MCP servers with
#    it. A graceful stop lets the server run killAllSessions(), which kills the
#    PTY workers and deliberately leaves tmux alive for the reconnect.
#
#    The unit is looked for as INSTALLED, not as active. A unit left in
#    'failed' (typically because someone else took the port while it was
#    down, e.g. an older desktop app's watchdog during the previous deploy)
#    is still the one that must own the server afterwards: treating it as
#    absent restarted the server by hand and made the problem permanent.
SERVICE_INSTALLED=false
if command -v systemctl >/dev/null 2>&1 && [ -f /etc/systemd/system/octoally.service ]; then
  SERVICE_INSTALLED=true
fi

# Empty when the port is free. `|| true` matters: under pipefail a grep with
# no match fails the pipeline, and `pid=$(port_pid)` would end the script.
port_pid() {
  ss -ltnpH "sport = :42010" 2>/dev/null | grep -o 'pid=[0-9]*' | head -1 | cut -d= -f2 || true
}

# Free port 42010 from whatever server holds it: SIGINT first (the path that
# keeps tmux alive), force only what refuses to let go.
free_port() {
  "$INSTALL_DIR/bin/octoally" stop >/dev/null 2>&1 || true
  local pid
  pid=$(port_pid)
  [ -n "$pid" ] && kill -INT "$pid" 2>/dev/null
  for _ in $(seq 1 10); do
    [ -z "$(port_pid)" ] && return 0
    sleep 1
  done
  log_error "Port 42010 still bound after a graceful stop: forcing it."
  log_error "Sessions open right now may not survive this."
  fuser -k 42010/tcp >/dev/null 2>&1 || true
  sleep 1
}

log_info "Stopping server..."
if [ "$SERVICE_INSTALLED" = true ]; then
  log_info "The systemd unit owns the server: stopping it there (needs sudo)."
  sudo systemctl stop octoally
fi
free_port

# 2. Install dependencies & build all
log_info "Installing dependencies..."
cd "$SRC_DIR"
npm run install:all 2>&1 | tail -1

log_info "Building dashboard + server..."
npm run build 2>&1 | tail -1

log_info "Building desktop-electron..."
cd "$SRC_DIR/desktop-electron"
npm install 2>&1 | tail -1
npm run build 2>&1 | tail -1

# 3. Deploy server to ~/octoally
log_info "Deploying server..."
rsync -a --delete "$SRC_DIR/server/dist/" "$INSTALL_DIR/server/dist/"
cp "$SRC_DIR/server/package.json" "$INSTALL_DIR/server/package.json"
# Copy new source files that may not exist in install (e.g. utils/)
rsync -a "$SRC_DIR/server/node_modules/" "$INSTALL_DIR/server/node_modules/" 2>/dev/null || true

# Refresh version.json so cli.mjs / install.sh see the new version
SRC_VERSION=$(node -e "console.log(require('$SRC_DIR/package.json').version)")
cat > "$INSTALL_DIR/version.json" <<VJSON
{
  "version": "$SRC_VERSION",
  "built_at": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "node_version": "$(node --version)"
}
VJSON

# 4. Deploy dashboard to ~/octoally
log_info "Deploying dashboard..."
rsync -a --delete "$SRC_DIR/dashboard/dist/" "$INSTALL_DIR/dashboard/dist/"

# 5. Deploy Electron app (requires sudo for /opt/OctoAlly)
if [ -f "$ELECTRON_ASAR" ]; then
  log_info "Deploying desktop-electron (needs sudo)..."
  TMPDIR=$(mktemp -d)
  npx --yes @electron/asar extract "$ELECTRON_ASAR" "$TMPDIR/app" 2>/dev/null
  cp "$SRC_DIR/desktop-electron/dist/main.js" "$TMPDIR/app/dist/main.js"
  cp "$SRC_DIR/desktop-electron/dist/main.js.map" "$TMPDIR/app/dist/main.js.map"
  cp "$SRC_DIR/desktop-electron/package.json" "$TMPDIR/app/package.json"
  npx --yes @electron/asar pack "$TMPDIR/app" "$TMPDIR/app-new.asar" 2>/dev/null
  sudo cp "$ELECTRON_ASAR" "${ELECTRON_ASAR}.bak"
  sudo cp "$TMPDIR/app-new.asar" "$ELECTRON_ASAR"
  rm -rf "$TMPDIR"
  log_ok "Electron app updated"
else
  log_info "Skipping Electron (no asar found at $ELECTRON_ASAR)"
fi

# 6. Restart the server the same way it was stopped. Starting it by hand while
#    the unit is enabled is how the port gets stolen from systemd: the unit
#    restart-loops on EADDRINUSE, burns through StartLimitBurst and lands in
#    'failed', leaving the install with nobody to bring it back up.
log_info "Restarting server..."
if [ "$SERVICE_INSTALLED" = true ]; then
  # The build took a while: whatever grabbed the port meanwhile goes first,
  # then the unit comes back with a clean slate.
  [ -n "$(port_pid)" ] && free_port
  sudo systemctl reset-failed octoally 2>/dev/null || true
  sudo systemctl start octoally
  # Check it is really the unit answering, not someone else's server.
  for _ in $(seq 1 15); do
    [ -n "$(port_pid)" ] && break
    sleep 1
  done
  OWNER_PID=$(port_pid)
  if [ -z "$OWNER_PID" ]; then
    log_error "Nothing is listening on 42010. Check: systemctl status octoally"
    exit 1
  fi
  # The unit's processes live in its control group, however deep the
  # launcher nests the node process.
  if ! grep -q '/octoally.service$' "/proc/$OWNER_PID/cgroup" 2>/dev/null; then
    log_error "Port 42010 is held by PID $OWNER_PID, which is not the systemd unit."
    log_error "An old desktop app probably restarted its own server: close it and run the deploy again."
    exit 1
  fi
  log_ok "Server running under the systemd unit (PID $OWNER_PID)"
else
  "$INSTALL_DIR/bin/octoally" start 2>/dev/null || true
fi

log_ok "Deploy complete! Launch octoally-desktop to test."
