#!/usr/bin/env bash
# OpenFlow Installer
# Downloads a pre-built release, extracts it, and starts the server.
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/ai-genius-automations/openflow/main/scripts/install.sh | bash
#   OPENFLOW_VERSION=0.1.0 bash install.sh
#   OPENFLOW_INSTALL_DIR=/opt/openflow bash install.sh
#
# For private repos / pre-release testing:
#   OPENFLOW_ARCHIVE_URL="https://example.com/openflow-v0.1.0.tar.gz" bash install.sh

set -euo pipefail

INSTALL_DIR="${OPENFLOW_INSTALL_DIR:-$HOME/openflow}"
GITHUB_REPO="${OPENFLOW_GITHUB_REPO:-ai-genius-automations/openflow}"
VERSION="${OPENFLOW_VERSION:-latest}"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m'

log_info()  { echo -e "${CYAN}[OpenFlow]${NC} $1"; }
log_ok()    { echo -e "${GREEN}[OpenFlow]${NC} $1"; }
log_warn()  { echo -e "${YELLOW}[OpenFlow]${NC} $1"; }
log_error() { echo -e "${RED}[OpenFlow]${NC} $1"; }
log_step()  { echo -e "\n${BOLD}[$1/$TOTAL_STEPS] $2${NC}"; }

TOTAL_STEPS=5

# Detect the target user (if running as root via sudo, install for the real user)
if [ "$(id -u)" -eq 0 ] && [ -n "${SUDO_USER:-}" ]; then
  TARGET_USER="$SUDO_USER"
  TARGET_HOME=$(eval echo "~$SUDO_USER")
  INSTALL_DIR="${OPENFLOW_INSTALL_DIR:-$TARGET_HOME/openflow}"
elif [ "$(id -u)" -eq 0 ]; then
  TARGET_USER="root"
  TARGET_HOME="$HOME"
else
  TARGET_USER="$(whoami)"
  TARGET_HOME="$HOME"
fi

# --- Step 1: Check prerequisites ---------------------------------------------

log_step 1 "Checking prerequisites..."

OS="$(uname -s)"

# Install Node.js if missing (the only system dep we need at runtime)
install_node_if_needed() {
  local NEED_NODE=false
  if ! command -v node &>/dev/null; then
    NEED_NODE=true
  else
    local NODE_MAJOR
    NODE_MAJOR=$(node -e "console.log(process.versions.node.split('.')[0])")
    if [ "$NODE_MAJOR" -lt 20 ]; then
      NEED_NODE=true
      log_warn "Node.js $NODE_MAJOR found, need 20+..."
    fi
  fi

  if [ "$NEED_NODE" = false ]; then return 0; fi

  case "$OS" in
    Linux*)
      log_info "Installing Node.js 22..."
      apt-get update -qq
      apt-get install -y -qq ca-certificates curl gnupg
      mkdir -p /etc/apt/keyrings
      curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key | gpg --dearmor -o /etc/apt/keyrings/nodesource.gpg 2>/dev/null || true
      echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_22.x nodistro main" | tee /etc/apt/sources.list.d/nodesource.list > /dev/null
      apt-get update -qq
      apt-get install -y -qq nodejs
      ;;
    Darwin*)
      if command -v brew &>/dev/null; then
        log_info "Installing Node.js via Homebrew..."
        brew install node 2>&1 | tail -1
      else
        log_error "Install Node.js 20+ first: https://nodejs.org"
        exit 1
      fi
      ;;
  esac
}

# Install tmux + dtach if missing (needed for agent sessions)
install_runtime_deps() {
  local NEEDED=()
  command -v tmux &>/dev/null  || NEEDED+=(tmux)
  command -v dtach &>/dev/null || NEEDED+=(dtach)
  command -v curl &>/dev/null  || NEEDED+=(curl)

  if [ ${#NEEDED[@]} -eq 0 ]; then return 0; fi

  case "$OS" in
    Linux*)
      log_info "Installing: ${NEEDED[*]}..."
      apt-get update -qq
      apt-get install -y -qq "${NEEDED[@]}"
      ;;
    Darwin*)
      if command -v brew &>/dev/null; then
        brew install "${NEEDED[@]}" 2>&1 | tail -1
      fi
      ;;
  esac
}

install_node_if_needed
install_runtime_deps

# Verify Node
if ! command -v node &>/dev/null; then
  log_error "Node.js is required. Install Node.js 20+ and re-run."
  exit 1
fi

# Check Claude Code
if ! command -v claude &>/dev/null; then
  log_error "Claude Code is required but not installed."
  echo ""
  echo "  Install it first:  npm install -g @anthropic-ai/claude-code"
  echo "  Then re-run this installer."
  echo ""
  exit 1
fi

log_ok "Prerequisites met (Node $(node -v), Claude Code $(claude --version 2>/dev/null || echo 'ok'))"

# --- Step 2: Download release ------------------------------------------------

log_step 2 "Downloading OpenFlow..."

ARCHIVE_URL="${OPENFLOW_ARCHIVE_URL:-}"

if [ -z "$ARCHIVE_URL" ]; then
  # Resolve version from GitHub Releases API
  if [ "$VERSION" = "latest" ]; then
    log_info "Fetching latest release from GitHub..."
    RELEASE_INFO=$(curl -sf "https://api.github.com/repos/$GITHUB_REPO/releases/latest" 2>/dev/null || echo "")
    if [ -z "$RELEASE_INFO" ]; then
      # No release yet — fall back to latest tag
      RELEASE_INFO=$(curl -sf "https://api.github.com/repos/$GITHUB_REPO/releases" 2>/dev/null | node -e '
        let d="";process.stdin.on("data",c=>d+=c);process.stdin.on("end",()=>{
          try{const a=JSON.parse(d);if(a[0])console.log(JSON.stringify(a[0]))}catch{}
        })' 2>/dev/null || echo "")
    fi
    if [ -z "$RELEASE_INFO" ]; then
      log_error "No releases found. Set OPENFLOW_ARCHIVE_URL to install from a direct URL."
      exit 1
    fi
    VERSION=$(echo "$RELEASE_INFO" | node -e 'let d="";process.stdin.on("data",c=>d+=c);process.stdin.on("end",()=>{try{console.log(JSON.parse(d).tag_name.replace(/^v/,""))}catch{process.exit(1)}})' 2>/dev/null)
  fi

  # Look for the tar.gz asset in the release
  ARCHIVE_URL="https://github.com/$GITHUB_REPO/releases/download/v${VERSION}/openflow-v${VERSION}.tar.gz"
fi

TMPFILE=$(mktemp)
log_info "Downloading $ARCHIVE_URL..."
if ! curl -fSL --progress-bar -o "$TMPFILE" "$ARCHIVE_URL" 2>&1; then
  rm -f "$TMPFILE"
  log_error "Download failed. Check the URL or version and try again."
  exit 1
fi

log_ok "Downloaded ($(du -h "$TMPFILE" | cut -f1))"

# --- Step 3: Extract and install ---------------------------------------------

log_step 3 "Installing to $INSTALL_DIR..."

# Stop existing server if running
if [ -f "$INSTALL_DIR/.openflow.pid" ]; then
  local_pid=$(cat "$INSTALL_DIR/.openflow.pid" 2>/dev/null || echo "")
  if [ -n "$local_pid" ] && kill -0 "$local_pid" 2>/dev/null; then
    log_info "Stopping existing server..."
    kill "$local_pid" 2>/dev/null || true
    sleep 1
  fi
fi

# Extract (archive contains openflow-vX.Y.Z/ directory)
EXTRACT_DIR=$(mktemp -d)
tar xzf "$TMPFILE" -C "$EXTRACT_DIR"
rm -f "$TMPFILE"

# Find the extracted directory
EXTRACTED=$(ls -d "$EXTRACT_DIR"/openflow-* 2>/dev/null | head -1)
if [ -z "$EXTRACTED" ] || [ ! -d "$EXTRACTED" ]; then
  log_error "Archive does not contain expected openflow-vX.Y.Z directory"
  rm -rf "$EXTRACT_DIR"
  exit 1
fi

# Move into place (preserve logs and config from existing install)
if [ -d "$INSTALL_DIR" ]; then
  # Preserve user data
  for keep in logs .openflow .openflow.pid; do
    [ -e "$INSTALL_DIR/$keep" ] && cp -r "$INSTALL_DIR/$keep" "$EXTRACT_DIR/_keep_$keep" 2>/dev/null || true
  done
  rm -rf "$INSTALL_DIR"
fi

mv "$EXTRACTED" "$INSTALL_DIR"

# Restore preserved data
for keep in logs .openflow .openflow.pid; do
  [ -e "$EXTRACT_DIR/_keep_$keep" ] && mv "$EXTRACT_DIR/_keep_$keep" "$INSTALL_DIR/$keep" 2>/dev/null || true
done
rm -rf "$EXTRACT_DIR"

mkdir -p "$INSTALL_DIR/logs"

# Read actual version from the installed package
if [ -f "$INSTALL_DIR/version.json" ]; then
  VERSION=$(node -e "console.log(require('$INSTALL_DIR/version.json').version)" 2>/dev/null || echo "$VERSION")
fi

log_ok "Installed to $INSTALL_DIR"

# --- Step 4: Install CLI -----------------------------------------------------

log_step 4 "Installing CLI..."

chmod +x "$INSTALL_DIR/bin/openflow"

LINK_DIR="/usr/local/bin"
if [ ! -w "$LINK_DIR" ]; then
  LINK_DIR="$TARGET_HOME/.local/bin"
  mkdir -p "$LINK_DIR"
fi

ln -sf "$INSTALL_DIR/bin/openflow" "$LINK_DIR/openflow"

# Fix ownership if running as root for another user
if [ "$(id -u)" -eq 0 ] && [ "$TARGET_USER" != "root" ]; then
  log_info "Setting ownership to $TARGET_USER..."
  chown -R "$TARGET_USER:$TARGET_USER" "$INSTALL_DIR"
fi

log_ok "CLI: $LINK_DIR/openflow"

# --- Step 5: Start server ----------------------------------------------------

log_step 5 "Starting OpenFlow..."

# Remove legacy Tauri desktop app if installed
if command -v dpkg &>/dev/null && dpkg -l open-flow &>/dev/null 2>&1; then
  log_info "Removing legacy desktop app..."
  dpkg -r open-flow 2>&1 || true
fi

# Start (as target user if we're root)
if [ "$(id -u)" -eq 0 ] && [ "$TARGET_USER" != "root" ]; then
  su - "$TARGET_USER" -c "PATH=\"$LINK_DIR:\$PATH\" openflow start"
else
  "$LINK_DIR/openflow" start
fi

# --- Done --------------------------------------------------------------------

echo ""
echo -e "${GREEN}${BOLD}OpenFlow v${VERSION} installed and running!${NC}"
echo ""
echo "  Dashboard:  http://localhost:42010"
echo "  CLI:        $LINK_DIR/openflow"
echo "  Install:    $INSTALL_DIR"
echo ""
echo "Commands:"
echo "  openflow status            # Check status"
echo "  openflow stop              # Stop the server"
echo "  openflow start             # Start the server"
echo "  openflow update            # Update to latest release"
echo "  openflow install-service   # Auto-start on boot"
echo ""
