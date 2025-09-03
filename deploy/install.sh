#!/usr/bin/env bash
set -euo pipefail

# Usage:
#   sudo bash deploy/install.sh \
#     --domain your.domain.com \
#     --email you@example.com \
#     [--repo https://github.com/zuliantoe/TTSLiveChatRelay.git] \
#     [--branch main] \
#     [--app-dir /opt/tiktok-live-chat-relay] \
#     [--service-name tiktok-relay] \
#     [--port 3001]

DOMAIN=""
EMAIL=""
REPO_URL="https://github.com/zuliantoe/TTSLiveChatRelay.git"
BRANCH="main"
APP_DIR="/opt/tiktok-live-chat-relay"
SERVICE_NAME="tiktok-relay"
PORT="3001"
SERVICE_USER="tiktokrelay"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --domain) DOMAIN="$2"; shift; shift;;
    --email) EMAIL="$2"; shift; shift;;
    --repo) REPO_URL="$2"; shift; shift;;
    --branch) BRANCH="$2"; shift; shift;;
    --app-dir) APP_DIR="$2"; shift; shift;;
    --service-name) SERVICE_NAME="$2"; shift; shift;;
    --port) PORT="$2"; shift; shift;;
    *) echo "Unknown arg: $1"; exit 1;;
  esac
done

if [[ -z "$DOMAIN" || -z "$EMAIL" ]]; then
  echo "Missing --domain or --email"
  exit 1
fi

if [[ "$(id -u)" -ne 0 ]]; then
  echo "Please run as root (use sudo)"
  exit 1
fi

export DEBIAN_FRONTEND=noninteractive

echo "[1/9] Install prerequisites (curl, git, nginx, certbot)"
apt-get update -y
apt-get install -y ca-certificates curl gnupg lsb-release git ufw nginx certbot python3-certbot-nginx

# Optional: basic firewall
if command -v ufw >/dev/null 2>&1; then
  ufw allow OpenSSH || true
  ufw allow 'Nginx Full' || true
fi

echo "[2/9] Install Node.js 22.x via NodeSource"
curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
apt-get install -y nodejs build-essential
node -v
npm -v

echo "[3/9] Create system user and app directory"
if ! id -u "$SERVICE_USER" >/dev/null 2>&1; then
  useradd --system --shell /usr/sbin/nologin --home "$APP_DIR" "$SERVICE_USER"
fi
mkdir -p "$APP_DIR"
chown -R "$SERVICE_USER":"$SERVICE_USER" "$APP_DIR"

echo "[4/9] Clone repository and build"
if [[ ! -d "$APP_DIR/.git" ]]; then
  sudo -u "$SERVICE_USER" git clone -b "$BRANCH" --depth=1 "$REPO_URL" "$APP_DIR"
else
  pushd "$APP_DIR" >/dev/null
  sudo -u "$SERVICE_USER" git fetch --all --prune
  sudo -u "$SERVICE_USER" git checkout "$BRANCH"
  sudo -u "$SERVICE_USER" git pull --rebase
  popd >/dev/null
fi

pushd "$APP_DIR" >/dev/null
sudo -u "$SERVICE_USER" npm ci --no-audit --no-fund
sudo -u "$SERVICE_USER" npm run build
popd >/dev/null

echo "[5/9] Write env file at /etc/${SERVICE_NAME}.env (PORT=${PORT})"
ENV_FILE="/etc/${SERVICE_NAME}.env"
cat > "$ENV_FILE" <<EOF
PORT=${PORT}
# Add HTTP(S)_PROXY if needed
# HTTP_PROXY=
# HTTPS_PROXY=
EOF
chmod 640 "$ENV_FILE"
chown root:"$SERVICE_USER" "$ENV_FILE"

echo "[6/9] Create systemd service ${SERVICE_NAME}.service"
SERVICE_PATH="/etc/systemd/system/${SERVICE_NAME}.service"
cat > "$SERVICE_PATH" <<EOF
[Unit]
Description=TikTok Live Chat Relay
After=network.target
StartLimitIntervalSec=0

[Service]
Type=simple
User=${SERVICE_USER}
WorkingDirectory=${APP_DIR}
EnvironmentFile=${ENV_FILE}
ExecStart=/usr/bin/node dist/server.js
Restart=always
RestartSec=2

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable "$SERVICE_NAME"
systemctl restart "$SERVICE_NAME"
sleep 1
systemctl --no-pager status "$SERVICE_NAME" || true

echo "[7/9] Configure Nginx reverse proxy for ${DOMAIN}"
# Ensure map for Connection upgrade exists in conf.d
MAP_FILE="/etc/nginx/conf.d/connection_upgrade_map.conf"
if [[ ! -f "$MAP_FILE" ]]; then
  cat > "$MAP_FILE" <<'NGX'
map $http_upgrade $connection_upgrade {
    default upgrade;
    ''      close;
}
NGX
fi

NGINX_CONF="/etc/nginx/sites-available/${SERVICE_NAME}.conf"
cat > "$NGINX_CONF" <<EOF
server {
    server_name ${DOMAIN};

    # Increase timeouts for SSE/WebSocket
    proxy_read_timeout 3600s;
    proxy_send_timeout 3600s;
    keepalive_timeout 65;

    location / {
        proxy_pass http://127.0.0.1:${PORT};
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;

        # WebSocket support
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection \$connection_upgrade;

        # SSE improvement
        proxy_buffering off;
    }
}
EOF

ln -sf "$NGINX_CONF" "/etc/nginx/sites-enabled/${SERVICE_NAME}.conf"
nginx -t
systemctl reload nginx

echo "[8/9] Obtain TLS certificate via certbot"
certbot --nginx -d "$DOMAIN" -m "$EMAIL" --agree-tos -n --redirect || true

echo "[9/9] Done. Test endpoints:"
echo "  SSE: https://${DOMAIN}/<username>"
echo "  WS:  wss://${DOMAIN}/<username>"
