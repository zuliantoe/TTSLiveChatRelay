#!/usr/bin/env bash
set -euo pipefail

# Usage:
#   sudo bash deploy/update.sh [--app-dir /opt/tiktok-live-chat-relay] [--service-name tiktok-relay] [--branch main]

APP_DIR="/opt/tiktok-live-chat-relay"
SERVICE_NAME="tiktok-relay"
BRANCH="main"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --app-dir) APP_DIR="$2"; shift; shift;;
    --service-name) SERVICE_NAME="$2"; shift; shift;;
    --branch) BRANCH="$2"; shift; shift;;
    *) echo "Unknown arg: $1"; exit 1;;
  esac
done

if [[ "$(id -u)" -ne 0 ]]; then
  echo "Please run as root (use sudo)"
  exit 1
fi

pushd "$APP_DIR" >/dev/null
sudo -u "$(stat -c %U "$APP_DIR" 2>/dev/null || stat -f %Su "$APP_DIR")" git fetch --all --prune
sudo -u "$(stat -c %U "$APP_DIR" 2>/dev/null || stat -f %Su "$APP_DIR")" git checkout "$BRANCH"
sudo -u "$(stat -c %U "$APP_DIR" 2>/dev/null || stat -f %Su "$APP_DIR")" git pull --rebase

sudo -u "$(stat -c %U "$APP_DIR" 2>/dev/null || stat -f %Su "$APP_DIR")" npm ci --no-audit --no-fund
sudo -u "$(stat -c %U "$APP_DIR" 2>/dev/null || stat -f %Su "$APP_DIR")" npm run build
popd >/dev/null

systemctl restart "$SERVICE_NAME"
systemctl --no-pager status "$SERVICE_NAME" || true

echo "Update completed and service restarted."
