#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
CONFIG_FILE="${ROOT_DIR}/config/deepagents.yml"

SUDO=""

# Determine if sudo is needed — deferred until NGINX_CONF is known.
# Call resolve_sudo() after select_nginx_conf_by_os().
resolve_sudo() {
  if [ "$(id -u)" -eq 0 ]; then
    SUDO=""
    return
  fi
  local conf_dir=""
  conf_dir="$(dirname "$NGINX_CONF")"
  # If we can write to the config dir and reload nginx without sudo, skip it
  if [ -w "$conf_dir" ] || mkdir -p "$conf_dir" 2>/dev/null; then
    # Also check if nginx reload works without sudo
    if nginx -t >/dev/null 2>&1; then
      SUDO=""
      return
    fi
  fi
  SUDO="sudo"
}

PROFILE=""
SERVER_NAMES="${NGINX_SERVER_NAMES:-${SERVER_NAMES:-}}"
LISTEN_PORTS="${NGINX_LISTEN_PORTS:-${LISTEN_PORTS:-}}"
BACKEND_HOST="${NGINX_BACKEND_HOST:-${BACKEND_HOST:-}}"
BACKEND_PORT="${NGINX_BACKEND_PORT:-${BACKEND_PORT:-}}"
WEB_ROOT="${WEB_ROOT:-}"
NGINX_CONF="${NGINX_CONF:-}"
NGINX_CONF_MACOS="${NGINX_CONF_MACOS:-}"
NGINX_CONF_UBUNTU="${NGINX_CONF_UBUNTU:-}"
PYTHON_BIN=""

if command -v python >/dev/null 2>&1; then
  PYTHON_BIN="python"
elif command -v python3 >/dev/null 2>&1; then
  PYTHON_BIN="python3"
else
  echo "Missing python interpreter (python/python3)." >&2
  exit 1
fi

usage() {
  echo "Usage: $0 [--profile <name>]" >&2
  echo "Reads nginx/web/backend settings from config/deepagents.yml profile.env" >&2
}

default_profile() {
  if [ ! -f "$CONFIG_FILE" ]; then
    echo ""
    return 0
  fi
  "$PYTHON_BIN" "${SCRIPT_DIR}/config_parser.py" default-profile "$CONFIG_FILE"
}

profile_exists() {
  local profile="$1"
  if [ -z "$profile" ] || [ ! -f "$CONFIG_FILE" ]; then
    return 1
  fi
  "$PYTHON_BIN" "${SCRIPT_DIR}/config_parser.py" profile-exists "$CONFIG_FILE" "$profile"
  return $?
}

resolve_profile() {
  if [ -z "$PROFILE" ]; then
    PROFILE="$(default_profile)"
  fi
  if [ -z "$PROFILE" ]; then
    echo "No profile configured in $CONFIG_FILE" >&2
    exit 1
  fi
  if ! profile_exists "$PROFILE"; then
    echo "Profile not found in $CONFIG_FILE: $PROFILE" >&2
    exit 1
  fi
}

parse_args() {
  while [ "$#" -gt 0 ]; do
    case "$1" in
      -p|--profile)
        if [ "$#" -lt 2 ]; then
          echo "Missing value for $1" >&2
          usage
          exit 1
        fi
        PROFILE="$2"
        shift 2
        ;;
      --profile=*)
        PROFILE="${1#*=}"
        shift
        ;;
      -h|--help)
        usage
        exit 0
        ;;
      *)
        echo "Unknown argument: $1" >&2
        usage
        exit 1
        ;;
    esac
  done
}

load_env_config() {
  if [ ! -f "$CONFIG_FILE" ]; then
    return 0
  fi
  "$PYTHON_BIN" "${SCRIPT_DIR}/config_parser.py" env "$CONFIG_FILE" "$PROFILE"
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

detect_os() {
  local uname_s=""
  uname_s="$(uname -s 2>/dev/null || true)"
  if [ "$uname_s" = "Darwin" ]; then
    echo "macos"
    return 0
  fi
  if [ "$uname_s" = "Linux" ]; then
    if [ -f /etc/os-release ] && grep -qi '^ID=ubuntu\|^ID_LIKE=.*ubuntu' /etc/os-release; then
      echo "ubuntu"
      return 0
    fi
    echo "linux"
    return 0
  fi
  echo "unknown"
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

detect_nginx_conf_auto() {
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

select_nginx_conf_by_os() {
  if [ -n "$NGINX_CONF" ]; then
    return 0
  fi

  local os_kind=""
  os_kind="$(detect_os)"
  case "$os_kind" in
    macos)
      if [ -n "$NGINX_CONF_MACOS" ]; then
        NGINX_CONF="$NGINX_CONF_MACOS"
        return 0
      fi
      ;;
    ubuntu)
      if [ -n "$NGINX_CONF_UBUNTU" ]; then
        NGINX_CONF="$NGINX_CONF_UBUNTU"
        return 0
      fi
      ;;
  esac

  detect_nginx_conf_auto
}

apply_defaults() {
  SERVER_NAMES="${SERVER_NAMES:-127.0.0.1 localhost}"
  LISTEN_PORTS="${LISTEN_PORTS:-${WEB_PORT:-8080}}"
  BACKEND_HOST="${BACKEND_HOST:-127.0.0.1}"
  BACKEND_PORT="${BACKEND_PORT:-${SERVER_PORT:-8000}}"

  if [ -z "$WEB_ROOT" ]; then
    echo "Missing WEB_ROOT in profile.env" >&2
    exit 1
  fi
}

parse_args "$@"
resolve_profile
export_env_config

SERVER_NAMES="${NGINX_SERVER_NAMES:-${SERVER_NAMES:-}}"
LISTEN_PORTS="${NGINX_LISTEN_PORTS:-${LISTEN_PORTS:-}}"
BACKEND_HOST="${NGINX_BACKEND_HOST:-${BACKEND_HOST:-}}"
BACKEND_PORT="${NGINX_BACKEND_PORT:-${BACKEND_PORT:-}}"

apply_defaults
ensure_nginx
select_nginx_conf_by_os
resolve_sudo

$SUDO mkdir -p "$WEB_ROOT"
target_user="${SUDO_USER:-$(id -un)}"
target_group="$(id -gn "${target_user}")"
if [ -n "$target_user" ]; then
  $SUDO chown -R "${target_user}:${target_group}" "$WEB_ROOT"
fi

LISTEN_PORTS="${LISTEN_PORTS//,/ }"
listen_block=""
for port in $LISTEN_PORTS; do
  listen_block+="    listen ${port};"$'\n'
done

tmp_conf="$(mktemp)"
cat > "$tmp_conf" <<EOF_CONF
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

    location ~ ^/(login|logout|me|sessions|history|session_state|user_config|files)(/|\$) {
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
EOF_CONF

echo "[1/1] Write nginx config to ${NGINX_CONF} (profile=${PROFILE})"
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

echo "Done. profile=${PROFILE} web_root=${WEB_ROOT} backend=${BACKEND_HOST}:${BACKEND_PORT} listen=${LISTEN_PORTS}"
