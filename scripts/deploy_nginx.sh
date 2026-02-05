#!/bin/bash
set -euo pipefail

SUDO=""
if [ "$(id -u)" -ne 0 ]; then
  SUDO="sudo"
fi

ENV_NAME="${1:-}"
SERVER_NAMES="${SERVER_NAMES:-}"
LISTEN_PORTS="${LISTEN_PORTS:-}"
BACKEND_HOST="${BACKEND_HOST:-}"
BACKEND_PORT="${BACKEND_PORT:-}"
WEB_ROOT="${WEB_ROOT:-}"
WEB_DEPLOY_DIR="${WEB_DEPLOY_DIR:-}"
NGINX_CONF="${NGINX_CONF:-}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
CONFIG_FILE="${ROOT_DIR}/config/deepagents.yml"

usage() {
  echo "Usage: $0 [dev|prod]" >&2
  echo "Optional overrides via env: SERVER_NAMES, LISTEN_PORTS, WEB_ROOT, BACKEND_HOST, BACKEND_PORT, NGINX_CONF" >&2
}

load_env_config() {
  if [ ! -f "$CONFIG_FILE" ]; then
    return 0
  fi
  if command -v python >/dev/null 2>&1; then
    python - "$CONFIG_FILE" <<'PY'
import sys

path = sys.argv[1]
current_section = None
env = {}

with open(path, "r", encoding="utf-8") as handle:
    for raw_line in handle:
        line = raw_line.rstrip("\n")
        stripped = line.strip()
        if not stripped or stripped.startswith("#"):
            continue
        indent = len(line) - len(line.lstrip(" "))
        if indent == 0:
            current_section = stripped.rstrip(":")
            continue
        if current_section != "env":
            continue
        if indent == 2 and ":" in stripped:
            raw_key, raw_value = stripped.split(":", 1)
            value = raw_value.strip()
            if (value.startswith('"') and value.endswith('"')) or (value.startswith("'") and value.endswith("'")):
                value = value[1:-1]
            env[raw_key.strip()] = value

for key, value in env.items():
    sys.stdout.write(f"{key}\t{value}\n")
PY
    return 0
  fi
  if command -v python3 >/dev/null 2>&1; then
    python3 - "$CONFIG_FILE" <<'PY'
import sys

path = sys.argv[1]
current_section = None
env = {}

with open(path, "r", encoding="utf-8") as handle:
    for raw_line in handle:
        line = raw_line.rstrip("\n")
        stripped = line.strip()
        if not stripped or stripped.startswith("#"):
            continue
        indent = len(line) - len(line.lstrip(" "))
        if indent == 0:
            current_section = stripped.rstrip(":")
            continue
        if current_section != "env":
            continue
        if indent == 2 and ":" in stripped:
            raw_key, raw_value = stripped.split(":", 1)
            value = raw_value.strip()
            if (value.startswith('"') and value.endswith('"')) or (value.startswith("'") and value.endswith("'")):
                value = value[1:-1]
            env[raw_key.strip()] = value

for key, value in env.items():
    sys.stdout.write(f"{key}\t{value}\n")
PY
    return 0
  fi
  echo "WARN: python not found; skipping env config from $CONFIG_FILE" >&2
}

export_env_config() {
  local key=""
  local value=""
  while IFS=$'\t' read -r key value; do
    if [ -n "$key" ]; then
      export "$key=$value"
    fi
  done < <(load_env_config)
}

apply_env_defaults() {
  case "$ENV_NAME" in
    dev)
      SERVER_NAMES="${SERVER_NAMES:-127.0.0.1 172.16.2.4}"
      LISTEN_PORTS="${LISTEN_PORTS:-8080}"
      WEB_ROOT="${WEB_ROOT:-/opt/deepagents}"
      WEB_DEPLOY_DIR="${WEB_DEPLOY_DIR:-$WEB_ROOT}"
      BACKEND_HOST="${BACKEND_HOST:-127.0.0.1}"
      BACKEND_PORT="${BACKEND_PORT:-8000}"
      ;;
    prod)
      SERVER_NAMES="${SERVER_NAMES:-test01.spark-truth.cn 172.16.2.49}"
      LISTEN_PORTS="${LISTEN_PORTS:-8080}"
      WEB_ROOT="${WEB_ROOT:-/usr/local/deepagents}"
      WEB_DEPLOY_DIR="${WEB_DEPLOY_DIR:-$WEB_ROOT}"
      BACKEND_HOST="${BACKEND_HOST:-127.0.0.1}"
      BACKEND_PORT="${BACKEND_PORT:-8000}"
      ;;
    *)
      usage
      exit 1
      ;;
  esac
}

ensure_nginx() {
  if command -v nginx >/dev/null 2>&1; then
    return 0
  fi
  echo "nginx not found, attempting install..."
  if command -v apt-get >/dev/null 2>&1; then
    $SUDO apt-get update -y
    $SUDO apt-get install -y nginx
    return 0
  fi
  if command -v dnf >/dev/null 2>&1; then
    $SUDO dnf install -y nginx
    return 0
  fi
  if command -v yum >/dev/null 2>&1; then
    $SUDO yum install -y nginx
    return 0
  fi
  if command -v brew >/dev/null 2>&1; then
    brew install nginx
    return 0
  fi
  echo "Could not install nginx automatically. Please install nginx and rerun." >&2
  exit 1
}

detect_nginx_conf() {
  if [ -n "${NGINX_CONF}" ]; then
    return 0
  fi

  local conf_path=""
  conf_path="$(nginx -V 2>&1 | sed -n 's/.*--conf-path=\([^ ]*\).*/\1/p' | head -n1)"
  if [ -n "$conf_path" ] && [ -f "$conf_path" ]; then
    if grep -Eq 'include\s+servers/\*;' "$conf_path"; then
      NGINX_CONF="$(dirname "$conf_path")/servers/deepagents.conf"
      return 0
    fi
    if grep -Eq 'include\s+/etc/nginx/conf\.d/\*\.conf;' "$conf_path"; then
      NGINX_CONF="/etc/nginx/conf.d/deepagents.conf"
      return 0
    fi
  fi

  if [ -d /etc/nginx/conf.d ]; then
    NGINX_CONF="/etc/nginx/conf.d/deepagents.conf"
    return 0
  fi
  if [ -d /opt/homebrew/etc/nginx/servers ]; then
    NGINX_CONF="/opt/homebrew/etc/nginx/servers/deepagents.conf"
    return 0
  fi

  NGINX_CONF="/etc/nginx/conf.d/deepagents.conf"
}

export_env_config
apply_env_defaults
ensure_nginx
detect_nginx_conf

if [ -n "${WEB_DEPLOY_DIR}" ] && [ -z "${WEB_ROOT}" ]; then
  WEB_ROOT="${WEB_DEPLOY_DIR}"
fi
if [ -n "${WEB_ROOT}" ] && [ -z "${WEB_DEPLOY_DIR}" ]; then
  WEB_DEPLOY_DIR="${WEB_ROOT}"
fi
if [ -n "${WEB_DEPLOY_DIR}" ] && [ -n "${WEB_ROOT}" ] && [ "${WEB_DEPLOY_DIR}" != "${WEB_ROOT}" ]; then
  echo "WARN: WEB_DEPLOY_DIR and WEB_ROOT differ; using WEB_DEPLOY_DIR for nginx root to avoid mismatch." >&2
  WEB_ROOT="${WEB_DEPLOY_DIR}"
fi

$SUDO mkdir -p "${WEB_DEPLOY_DIR}"
target_user="${SUDO_USER:-$(id -un)}"
target_group="$(id -gn "${target_user}")"
if [ -n "$target_user" ]; then
  $SUDO chown -R "${target_user}:${target_group}" "${WEB_DEPLOY_DIR}"
fi

LISTEN_PORTS="${LISTEN_PORTS//,/ }"
listen_block=""
for port in $LISTEN_PORTS; do
  listen_block+="    listen ${port};"$'\n'
done

tmp_conf="$(mktemp)"
cat > "$tmp_conf" <<EOF
server {
${listen_block}    server_name ${SERVER_NAMES};

    root ${WEB_ROOT};
    index index.html;

    location / {
        add_header Cache-Control "no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0" always;
        add_header Pragma "no-cache" always;
        add_header Expires "0" always;
        try_files \$uri /index.html;
    }

    location ~* \\.(?:html|js|css|json|map)\$ {
        add_header Cache-Control "no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0" always;
        add_header Pragma "no-cache" always;
        add_header Expires "0" always;
        try_files \$uri =404;
    }

    location ~ ^/(login|logout|me|sessions|history|session_state|user_config|files)(/|$) {
        proxy_pass http://${BACKEND_HOST}:${BACKEND_PORT};
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
    }

    location /ws/ {
        proxy_pass http://${BACKEND_HOST}:${BACKEND_PORT};
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host \$host;
    }
}
EOF

echo "[1/1] Write nginx config to ${NGINX_CONF}"
$SUDO mkdir -p "$(dirname "$NGINX_CONF")"
$SUDO mv "$tmp_conf" "$NGINX_CONF"
$SUDO chmod 644 "$NGINX_CONF"
$SUDO nginx -t
if command -v systemctl >/dev/null 2>&1; then
  $SUDO systemctl reload nginx || $SUDO systemctl restart nginx
else
  if ! $SUDO nginx -s reload; then
    echo "nginx reload failed; attempting to start nginx"
    $SUDO nginx
  fi
fi

echo "Done."
