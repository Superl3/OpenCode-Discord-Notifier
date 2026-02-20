#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

log_step() {
  printf "\n[bootstrap] %s\n" "$1"
}

log_info() {
  printf "[bootstrap] %s\n" "$1"
}

has_cmd() {
  command -v "$1" >/dev/null 2>&1
}

ensure_node_npm() {
  if has_cmd node && has_cmd npm; then
    log_info "node/npm already installed"
    return
  fi

  log_step "node/npm missing; attempting auto-install"

  if has_cmd brew; then
    brew install node
  elif has_cmd apt-get; then
    sudo DEBIAN_FRONTEND=noninteractive apt-get update -y
    sudo DEBIAN_FRONTEND=noninteractive apt-get install -y nodejs npm
  elif has_cmd dnf; then
    sudo dnf install -y nodejs npm
  elif has_cmd yum; then
    sudo yum install -y nodejs npm
  elif has_cmd pacman; then
    sudo pacman -Sy --noconfirm nodejs npm
  else
    echo "Cannot auto-install node/npm. Install them manually and retry." >&2
    exit 1
  fi

  if ! has_cmd node || ! has_cmd npm; then
    echo "node/npm still unavailable after install." >&2
    exit 1
  fi
}

ensure_node_npm

cd "$REPO_ROOT"
node "$SCRIPT_DIR/bootstrap-opencode.js" "$@"
