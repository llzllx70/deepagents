#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
cd "$ROOT_DIR"

CONFIG_FILE="${ROOT_DIR}/config/deepagents.yml"
MODEL_CONFIG_FILE="${ROOT_DIR}/config/model.yml"

# --- Option state ---
OPT_PROFILE=""
OPT_MODEL=""
PYTHON_BIN=""

if command -v python >/dev/null 2>&1; then
  PYTHON_BIN="python"
elif command -v python3 >/dev/null 2>&1; then
  PYTHON_BIN="python3"
else
  echo "Missing python interpreter (python/python3)." >&2
  exit 1
fi

# ============================================================
# Usage
# ============================================================

usage() {
  cat <<EOF
  1  Restart server
  2  Deploy web (sync + nginx)
  3  Restart server + deploy web
  4  Status
  5  Server logs
  6  Nginx config
  Or type: start|stop|deploy|status|log|nginx|model|profile
EOF
}

# ============================================================
# Helpers
# ============================================================

die() {
  echo "Error: $*" >&2
  return 1
}

# ============================================================
# Config reading (via config_parser.py)
# ============================================================

require_config_file() {
  if [ ! -f "$CONFIG_FILE" ]; then
    echo "Missing config file: $CONFIG_FILE" >&2
    exit 1
  fi
}

require_model_config_file() {
  if [ ! -f "$MODEL_CONFIG_FILE" ]; then
    echo "Missing model config file: $MODEL_CONFIG_FILE" >&2
    exit 1
  fi
}

default_profile() {
  "$PYTHON_BIN" "${SCRIPT_DIR}/config_parser.py" default-profile "$CONFIG_FILE"
}

profile_list() {
  "$PYTHON_BIN" "${SCRIPT_DIR}/config_parser.py" profile-list "$CONFIG_FILE"
}

profile_exists() {
  local profile="$1"
  if [ -z "$profile" ]; then
    return 1
  fi
  "$PYTHON_BIN" "${SCRIPT_DIR}/config_parser.py" profile-exists "$CONFIG_FILE" "$profile"
  return $?
}

resolve_profile() {
  if [ -z "$OPT_PROFILE" ]; then
    OPT_PROFILE="$(default_profile)"
  fi
  if [ -z "$OPT_PROFILE" ]; then
    echo "No profile configured in $CONFIG_FILE (need default_profile and profiles)." >&2
    exit 1
  fi
  if ! profile_exists "$OPT_PROFILE"; then
    echo "Profile not found in $CONFIG_FILE: $OPT_PROFILE" >&2
    local profiles=""
    profiles="$(profile_list | paste -sd "," -)"
    if [ -n "$profiles" ]; then
      echo "Available profiles: $profiles" >&2
    fi
    exit 1
  fi
}

# Interactive profile selector — used at startup and by 'profile' command
prompt_profile() {
  local profiles_raw=""
  profiles_raw="$(profile_list)"
  if [ -z "$profiles_raw" ]; then
    return
  fi

  local profiles=()
  while IFS= read -r p; do
    [ -n "$p" ] && profiles+=("$p")
  done <<< "$profiles_raw"

  if [ "${#profiles[@]}" -le 1 ]; then
    return
  fi

  local current="${OPT_PROFILE:-$(default_profile)}"

  echo "Available profiles:"
  local i=1
  for p in "${profiles[@]}"; do
    if [ "$p" = "$current" ]; then
      echo "  [$i] $p *"
    else
      echo "  [$i] $p"
    fi
    i=$((i + 1))
  done
  printf "Select profile (current: %s): " "$current"

  local choice=""
  if ! read -r choice; then
    return
  fi
  choice="${choice//[[:space:]]/}"

  if [ -z "$choice" ]; then
    return
  fi

  if [[ "$choice" =~ ^[0-9]+$ ]] && [ "$choice" -ge 1 ] && [ "$choice" -le "${#profiles[@]}" ]; then
    OPT_PROFILE="${profiles[$((choice - 1))]}"
  elif profile_exists "$choice"; then
    OPT_PROFILE="$choice"
  else
    echo "Invalid selection, keeping: $current"
    return
  fi
  echo "Switched to profile: $OPT_PROFILE"
}

load_env_config() {
  "$PYTHON_BIN" "${SCRIPT_DIR}/config_parser.py" env "$CONFIG_FILE" "$OPT_PROFILE"
}

export_env_config() {
  require_config_file
  local key=""
  local value=""
  while IFS=$'\t' read -r key value; do
    if [ -n "$key" ]; then
      export "$key=$value"
    fi
  done < <(load_env_config)
}

scene_config_value() {
  local scene="$1"
  "$PYTHON_BIN" "${SCRIPT_DIR}/config_parser.py" profile-scene-val "$CONFIG_FILE" "$OPT_PROFILE" "$scene"
}

export_scene_env() {
  local scene=""
  local scene_model=""
  local scene_key=""
  for scene in main image-understand image-create; do
    scene_model="$(scene_config_value "$scene")"
    if [ -n "$scene_model" ]; then
      scene_key="$(echo "$scene" | tr '[:lower:]-' '[:upper:]_')"
      export "DEEPAGENTS_SCENE_${scene_key}=$scene_model"
    fi
  done
  export DEEPAGENTS_PROFILE="$OPT_PROFILE"
}

default_main_model() {
  local scene_model=""
  scene_model="$(scene_config_value "main")"
  if [ -n "$scene_model" ]; then
    echo "$scene_model"
    return 0
  fi
  echo "glm"
}

model_config_value() {
  local model="$1"
  local key="$2"
  require_model_config_file
  "$PYTHON_BIN" "${SCRIPT_DIR}/config_parser.py" model-val "$MODEL_CONFIG_FILE" "$model" "$key"
}

model_config_keys() {
  require_model_config_file
  "$PYTHON_BIN" "${SCRIPT_DIR}/config_parser.py" model-keys "$MODEL_CONFIG_FILE"
}

model_exists() {
  local model="$1"
  if [ -z "$model" ]; then
    return 1
  fi
  require_model_config_file
  "$PYTHON_BIN" "${SCRIPT_DIR}/config_parser.py" model-exists "$MODEL_CONFIG_FILE" "$model"
  return $?
}

set_model_env() {
  local model="$1"
  local api_key=""
  local base_url=""
  local model_name=""

  api_key="$(model_config_value "$model" "api_key")"
  base_url="$(model_config_value "$model" "base_url")"
  model_name="$(model_config_value "$model" "model")"

  if [ -z "$api_key" ] || [ -z "$base_url" ] || [ -z "$model_name" ]; then
    echo "Missing model config for $model in $MODEL_CONFIG_FILE" >&2
    return 1
  fi

  export OPENAI_API_KEY="$api_key"
  export OPENAI_BASE_URL="$base_url"
  export OPENAI_MODEL="$model_name"
}

# ============================================================
# Model resolution
# ============================================================

resolve_model() {
  local model="${OPT_MODEL:-}"
  if [ -z "$model" ]; then
    model="$(default_main_model)"
  fi
  if ! model_exists "$model"; then
    die "model '$model' not found in $MODEL_CONFIG_FILE"
    return 1
  fi
  echo "$model"
}

# ============================================================
# Service primitives
# ============================================================

ensure_logs() {
  mkdir -p logs
}

start_detached() {
  local label="$1"
  local log_file="$2"
  shift 2
  if command -v setsid >/dev/null 2>&1; then
    nohup setsid "$@" > "$log_file" 2>&1 < /dev/null &
  else
    nohup "$PYTHON_BIN" - "$@" > "$log_file" 2>&1 < /dev/null <<'PY' &
import os
import sys

os.setsid()
os.execvp(sys.argv[1], sys.argv[1:])
PY
  fi
  echo "$label started: pid=$!"
}

stop_server() {
  echo "Stopping server..."
  pkill -f "server.deepagents_server" >/dev/null 2>&1 || true
}

start_server() {
  local model
  model="$(resolve_model)"
  ensure_logs
  export_env_config
  export_scene_env
  set_model_env "$model"
  echo "Starting server (profile=$OPT_PROFILE, model=$model, openai_model=$OPENAI_MODEL)..."
  start_detached "Server" "logs/server.log" "$PYTHON_BIN" -m server.deepagents_server
}

# ============================================================
# File sync
# ============================================================

sync_dir() {
  local src="$1"
  local dst="$2"
  if [ -z "$src" ] || [ -z "$dst" ]; then
    echo "sync_dir: missing source or destination" >&2
    exit 1
  fi
  if [ ! -d "$src" ]; then
    echo "sync_dir: source not found: $src" >&2
    exit 1
  fi
  if [ "$dst" = "/" ]; then
    echo "sync_dir: invalid destination: $dst" >&2
    exit 1
  fi
  mkdir -p "$dst"
  if command -v rsync >/dev/null 2>&1; then
    if [ "$(id -u)" -eq 0 ]; then
      rsync -a --delete --exclude ".DS_Store" --exclude "node_modules" "$src"/ "$dst"/
    else
      rsync -a --delete --no-perms --no-group --exclude ".DS_Store" --exclude "node_modules" "$src"/ "$dst"/
    fi
  else
    find "$dst" -mindepth 1 -maxdepth 1 -exec rm -rf {} + 2>/dev/null || true
    cp -a "$src"/. "$dst"/
  fi
}

update_web() {
  export_env_config
  local target="${WEB_ROOT:-}"
  if [ -z "$target" ]; then
    echo "Missing WEB_ROOT; set it in profile.env." >&2
    return 1
  fi
  echo "Updating web to $target..."
  sync_dir "$ROOT_DIR/web" "$target"
  echo "Web updated: $target"
}

deploy_nginx() {
  export_env_config
  echo "Deploying nginx (profile=$OPT_PROFILE)..."
  "${SCRIPT_DIR}/deploy_nginx.sh" --profile "$OPT_PROFILE"
}

# ============================================================
# Status / log display
# ============================================================

print_header() {
  echo "【$1】"
}

# Resolve nginx conf path for the current profile/OS
resolve_nginx_conf() {
  export_env_config
  local conf="${NGINX_CONF:-}"
  if [ -n "$conf" ]; then
    echo "$conf"
    return
  fi
  local os_kind=""
  os_kind="$(uname -s 2>/dev/null || true)"
  if [ "$os_kind" = "Darwin" ] && [ -n "${NGINX_CONF_MACOS:-}" ]; then
    echo "$NGINX_CONF_MACOS"
  elif [ -n "${NGINX_CONF_UBUNTU:-}" ]; then
    echo "$NGINX_CONF_UBUNTU"
  else
    echo ""
  fi
}

# Compact status overview
show_status() {
  export_env_config

  print_header "Status"

  # Profile & model
  local model
  model="$(default_main_model)"
  echo "  Profile : $OPT_PROFILE"
  echo "  Model   : $model"

  # Ports
  local server_port="${SERVER_PORT:-8000}"
  local web_port="${WEB_PORT:-8080}"
  echo "  Ports   : server=$server_port  web=$web_port"

  # Server process
  if pgrep -f "server.deepagents_server" >/dev/null 2>&1; then
    local pids=""
    pids="$(pgrep -f "server.deepagents_server" | paste -sd "," -)"
    echo "  Server  : running (pid=$pids)"
  else
    echo "  Server  : stopped"
  fi

  # Web deploy
  local web_root="${WEB_ROOT:-}"
  if [ -z "$web_root" ]; then
    echo "  Web     : WEB_ROOT not set"
  elif [ -d "$web_root" ]; then
    local count
    count="$(find "$web_root" -type f 2>/dev/null | wc -l | tr -d ' ')"
    echo "  Web     : $web_root ($count files)"
  else
    echo "  Web     : $web_root (not found)"
  fi

  # Nginx conf
  local nginx_conf=""
  nginx_conf="$(resolve_nginx_conf)"
  if [ -n "$nginx_conf" ] && [ -f "$nginx_conf" ]; then
    echo "  Nginx   : $nginx_conf"
  elif [ -n "$nginx_conf" ]; then
    echo "  Nginx   : $nginx_conf (not found)"
  fi
}

follow_log_file() {
  local label="$1"
  local file="$2"
  local prev_trap=""
  print_header "$label"
  if [ -f "$file" ]; then
    echo "Press Ctrl-C to stop."
    tail -n 50 -f "$file" &
    local tail_pid=$!
    prev_trap="$(trap -p INT)"
    trap 'kill "$tail_pid" >/dev/null 2>&1 || true; wait "$tail_pid" >/dev/null 2>&1 || true; eval "$prev_trap"; return 0' INT
    wait "$tail_pid" >/dev/null 2>&1 || true
    if [ -n "$prev_trap" ]; then
      eval "$prev_trap"
    else
      trap - INT
    fi
  else
    echo "  $file not found"
  fi
}

# ============================================================
# Command handlers
# ============================================================

cmd_start() {
  start_server
}

cmd_stop() {
  stop_server
}

cmd_restart() {
  stop_server
  start_server
}

cmd_status() {
  show_status
}

cmd_log() {
  ensure_logs
  follow_log_file "Server Log" "logs/server.log"
}

cmd_deploy() {
  stop_server
  start_server
  update_web
  deploy_nginx
}

cmd_deploy_web() {
  update_web
  deploy_nginx
}

cmd_nginx() {
  local nginx_conf=""
  nginx_conf="$(resolve_nginx_conf)"
  if [ -z "$nginx_conf" ]; then
    echo "No nginx conf path configured for this profile." >&2
    return 1
  fi
  if [ ! -f "$nginx_conf" ]; then
    echo "Nginx conf not found: $nginx_conf" >&2
    return 1
  fi
  print_header "Nginx Config: $nginx_conf"
  cat "$nginx_conf"
}

cmd_profile() {
  local name="${1:-}"
  if [ -n "$name" ]; then
    if profile_exists "$name"; then
      OPT_PROFILE="$name"
      echo "Switched to profile: $OPT_PROFILE"
    else
      die "profile '$name' not found"
    fi
  else
    prompt_profile
  fi
}

cmd_model() {
  local subcmd="${1:-}"
  shift || true

  case "$subcmd" in
    list)
      cmd_model_list
      ;;
    set)
      cmd_model_set "${1:-}"
      ;;
    *)
      echo "Usage: model list | set <name>" >&2
      return 1
      ;;
  esac
}

cmd_model_list() {
  local current
  current="$(default_main_model)"
  local keys
  keys="$(model_config_keys)"
  if [ -z "$keys" ]; then
    echo "No models configured in $MODEL_CONFIG_FILE"
    return 0
  fi
  echo "Models (current: $current):"
  while IFS= read -r name; do
    if [ "$name" = "$current" ]; then
      echo "  * $name"
    else
      echo "    $name"
    fi
  done <<< "$keys"
}

cmd_model_set() {
  local name="${1:-}"
  if [ -z "$name" ]; then
    die "usage: model set <name>"
    return 1
  fi
  if ! model_exists "$name"; then
    die "model '$name' not found in $MODEL_CONFIG_FILE"
    return 1
  fi
  "$PYTHON_BIN" - "$CONFIG_FILE" "$OPT_PROFILE" "$name" <<'PY'
import sys
from pathlib import Path

try:
    import yaml
except ImportError:
    yaml = None

path = Path(sys.argv[1])
profile = sys.argv[2]
new_model = sys.argv[3]

if yaml is not None:
    data = yaml.safe_load(path.read_text(encoding="utf-8")) or {}
    profiles = data.get("profiles", {})
    if profile in profiles:
        section = profiles[profile]
        if "scenes" not in section:
            section["scenes"] = {}
        section["scenes"]["main"] = new_model
    path.write_text(yaml.safe_dump(data, allow_unicode=True, sort_keys=False, default_flow_style=False), encoding="utf-8")
    print(f"Default model for profile '{profile}' set to: {new_model}")
else:
    print("PyYAML not available; cannot update config.", file=sys.stderr)
    sys.exit(1)
PY
}

# ============================================================
# CLI parser
# ============================================================

parse_global_opts() {
  local args=()
  while [ "$#" -gt 0 ]; do
    case "$1" in
      -p|--profile)
        OPT_PROFILE="${2:-}"
        shift 2
        ;;
      --profile=*)
        OPT_PROFILE="${1#*=}"
        shift
        ;;
      -m|--model)
        OPT_MODEL="${2:-}"
        shift 2
        ;;
      -h|--help)
        usage
        exit 0
        ;;
      *)
        args+=("$1")
        shift
        ;;
    esac
  done
  REMAINING_ARGS=("${args[@]+"${args[@]}"}")
}

dispatch() {
  local cmd="${1:-}"
  shift || true

  case "$cmd" in
    start)         cmd_start ;;
    stop)          cmd_stop ;;
    restart|1)     cmd_restart ;;
    deploy)        cmd_deploy ;;
    2)             cmd_deploy_web ;;
    3)             cmd_restart; cmd_deploy_web ;;
    status|4)      cmd_status ;;
    log|5)         cmd_log ;;
    nginx|6)       cmd_nginx ;;
    model)         cmd_model "$@" ;;
    profile)       cmd_profile "$@" ;;
    help|h|-h|--help)
      usage
      ;;
    "")
      return 0
      ;;
    *)
      echo "Unknown: $cmd" >&2
      return 1
      ;;
  esac
}

# ============================================================
# Interactive REPL
# ============================================================

interactive_repl() {
  show_status
  local line=""
  while true; do
    echo ""
    usage
    printf "(%s) > " "$OPT_PROFILE"
    if ! read -r line; then
      echo
      break
    fi
    line="${line#"${line%%[![:space:]]*}"}"
    line="${line%"${line##*[![:space:]]}"}"
    if [ -z "$line" ]; then
      continue
    fi
    case "$line" in
      exit|quit|q)
        echo "Bye."
        break
        ;;
    esac
    # Reset per-command option state
    OPT_MODEL=""
    local words=()
    read -ra words <<< "$line"
    parse_global_opts "${words[@]}"
    dispatch "${REMAINING_ARGS[@]+"${REMAINING_ARGS[@]}"}" || true
  done
}

# ============================================================
# Main entry
# ============================================================

REMAINING_ARGS=()

parse_global_opts "$@"

# Interactive mode: prompt for profile selection if not specified via CLI
if [ "${#REMAINING_ARGS[@]}" -eq 0 ] && [ -z "$OPT_PROFILE" ]; then
  prompt_profile
fi

resolve_profile

if [ "${#REMAINING_ARGS[@]}" -gt 0 ]; then
  dispatch "${REMAINING_ARGS[@]}"
else
  interactive_repl
fi
