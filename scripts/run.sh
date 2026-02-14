#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
cd "$ROOT_DIR"

CONFIG_FILE="${ROOT_DIR}/config/deepagents.yml"
if [ ! -f "$CONFIG_FILE" ]; then
  echo "Missing config file: $CONFIG_FILE" >&2
  exit 1
fi

MODEL_CONFIG_FILE="${ROOT_DIR}/config/model.yml"

SCENE_CONFIG_FILE="${ROOT_DIR}/config/llm-scene.yml"

usage() {
  echo "Usage: $0 [start|stop|stop-server|restart|process|log|update-web|update-all|deploy] [all|server|web] [main-model]" >&2
  echo "start/stop/stop-server/restart are server-only (web has no start/restart)." >&2
  echo "update-web copies web/ to WEB_DEPLOY_DIR (target=web or all)." >&2
  echo "update-all restarts server first, then updates web." >&2
  echo "deploy updates web and restarts server; model is needed only for server targets." >&2
  echo "Main model defaults to the 'main' entry in config/llm-scene.yml" >&2
}

validate_action() {
  case "$ACTION" in
    start|stop|stop-server|restart|process|log|update-web|update-all|deploy) ;;
    *)
      usage
      exit 1
      ;;
  esac
}

validate_target() {
  case "$TARGET" in
    all|server|web) ;;
    *)
      usage
      exit 1
      ;;
  esac
}

require_model_config_file() {
  if [ ! -f "$MODEL_CONFIG_FILE" ]; then
    echo "Missing model config file: $MODEL_CONFIG_FILE" >&2
    exit 1
  fi
}

require_scene_config_file() {
  if [ ! -f "$SCENE_CONFIG_FILE" ]; then
    echo "Missing LLM scene config file: $SCENE_CONFIG_FILE" >&2
    exit 1
  fi
}

load_env_config() {
  python "${SCRIPT_DIR}/config_parser.py" env "$CONFIG_FILE"
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

scene_config_value() {
  local scene="$1"
  require_scene_config_file
  python "${SCRIPT_DIR}/config_parser.py" scene-val "$SCENE_CONFIG_FILE" "$scene"
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
  python "${SCRIPT_DIR}/config_parser.py" model-val "$MODEL_CONFIG_FILE" "$model" "$key"
}

model_config_keys() {
  require_model_config_file
  python "${SCRIPT_DIR}/config_parser.py" model-keys "$MODEL_CONFIG_FILE"
}

model_exists() {
  local model="$1"
  if [ -z "$model" ]; then
    return 1
  fi
  require_model_config_file
  python "${SCRIPT_DIR}/config_parser.py" model-exists "$MODEL_CONFIG_FILE" "$model"
  return $?
}

validate_model() {
  if model_exists "$MODEL"; then
    return 0
  fi
  usage
  exit 1
}

set_model_env() {
  local api_key=""
  local base_url=""
  local model_name=""

  api_key="$(model_config_value "$MODEL" "api_key")"
  base_url="$(model_config_value "$MODEL" "base_url")"
  model_name="$(model_config_value "$MODEL" "model")"

  if [ -z "$api_key" ] || [ -z "$base_url" ] || [ -z "$model_name" ]; then
    echo "Missing model config for $MODEL in $MODEL_CONFIG_FILE" >&2
    exit 1
  fi

  export OPENAI_API_KEY="$api_key"
  export OPENAI_BASE_URL="$base_url"
  export OPENAI_MODEL="$model_name"
}

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
    nohup python - "$@" > "$log_file" 2>&1 < /dev/null <<'PY' &
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
  ensure_logs
  export_env_config
  set_model_env
  echo "Starting server (model=$MODEL, openai_model=$OPENAI_MODEL)..."
  start_detached "Server" "logs/server.log" python -m server.deepagents_server
}

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
  local target="${WEB_DEPLOY_DIR:-}"
  if [ -z "$target" ]; then
    echo "Missing WEB_DEPLOY_DIR; set it to the nginx web root." >&2
    exit 1
  fi
  echo "Updating web to $target..."
  sync_dir "$ROOT_DIR/web" "$target"
  echo "Web updated: $target"
}

print_header() {
  echo "【$1】"
}

interactive_interrupt() {
  INTERRUPTED=1
  echo >&2
}

enable_interactive_trap() {
  trap 'interactive_interrupt' INT
}

show_server_process() {
  print_header "Server Process"
  if pgrep -f "server.deepagents_server" >/dev/null 2>&1; then
    while read -r pid; do
      cmd="$(ps -p "$pid" -o command=)"
      echo "  pid=$pid cmd=$cmd"
    done < <(pgrep -f "server.deepagents_server")
  else
    echo "  not running"
  fi
}

show_web_process() {
  print_header "Web Process"
  echo "  static assets; no process"
}

follow_log_file() {
  local label="$1"
  local file="$2"
  local prev_trap=""
  print_header "$label"
  if [ -f "$file" ]; then
    echo "Press Ctrl-C to return to the menu."
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

follow_logs_all() {
  local files=()
  local prev_trap=""
  if [ -f logs/server.log ]; then
    files+=("logs/server.log")
  fi
  print_header "Logs Follow"
  if [ "${#files[@]}" -gt 0 ]; then
    echo "Press Ctrl-C to return to the menu."
    tail -n 50 -f "${files[@]}" &
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
    echo "  no log files found"
  fi
}

do_start() {
  if [ "$TARGET" = "all" ] || [ "$TARGET" = "server" ]; then
    start_server
  fi
}

do_stop() {
  if [ "$TARGET" = "all" ] || [ "$TARGET" = "server" ]; then
    stop_server
  fi
}

action_requires_model() {
  case "$ACTION" in
    start|restart|update-all|deploy)
      if [ "$TARGET" = "server" ] || [ "$TARGET" = "all" ]; then
        return 0
      fi
      ;;
  esac
  return 1
}

validate_target_for_action() {
  case "$ACTION" in
    start|stop|stop-server|restart)
      if [ "$TARGET" = "web" ]; then
        usage
        exit 1
      fi
      if [ "$TARGET" = "all" ]; then
        TARGET="server"
      fi
      ;;
    update-web)
      if [ "$TARGET" = "server" ]; then
        usage
        exit 1
      fi
      if [ "$TARGET" = "all" ]; then
        TARGET="web"
      fi
      ;;
    update-all)
      TARGET="all"
      ;;
  esac
}

do_action() {
  validate_action
  validate_target
  validate_target_for_action
  if action_requires_model; then
    if [ -z "$MODEL" ]; then
      MODEL="$(default_main_model)"
    fi
    validate_model
  else
    MODEL=""
  fi

  case "$ACTION" in
    start)
      do_start
      ;;
    stop|stop-server)
      do_stop
      ;;
    restart)
      do_stop
      do_start
      ;;
    update-web)
      if [ "$TARGET" = "all" ] || [ "$TARGET" = "web" ]; then
        update_web
      fi
      ;;
    update-all)
      do_stop
      do_start
      update_web
      ;;
    deploy)
      if [ "$TARGET" = "all" ] || [ "$TARGET" = "web" ]; then
        update_web
      fi
      if [ "$TARGET" = "all" ] || [ "$TARGET" = "server" ]; then
        stop_server
        start_server
      fi
      ;;
    process)
      if [ "$TARGET" = "all" ] || [ "$TARGET" = "server" ]; then
        show_server_process
      fi
      if [ "$TARGET" = "all" ] || [ "$TARGET" = "web" ]; then
        show_web_process
      fi
      ;;
    log)
      ensure_logs
      if [ "$TARGET" = "all" ]; then
        follow_logs_all
      elif [ "$TARGET" = "server" ]; then
        follow_log_file "Server Log" "logs/server.log"
      elif [ "$TARGET" = "web" ]; then
        echo "Web logs are now printed in the browser console."
      fi
      ;;
  esac

  if [ -n "$MODEL" ]; then
    echo "Done: action=$ACTION target=$TARGET model=$MODEL"
  else
    echo "Done: action=$ACTION target=$TARGET"
  fi
}

prompt_primary_action() {
  local result_var="$1"
  local indent="$2"
  local choice=""
  while true; do
    echo "${indent}Select action: [1] show [2] restart-server [3] update-web [4] update-all [5] deploy [0] exit (default: show)" >&2
    if ! read_with_interrupt choice; then
      return 1
    fi
    choice="${choice//[[:space:]]/}"
    if [ "${INTERRUPTED:-0}" -eq 1 ]; then
      INTERRUPTED=0
      return 1
    fi
    case "${choice:-1}" in
      1|show) printf -v "$result_var" "%s" "show"; return 0 ;;
      2|restart|restart-server) printf -v "$result_var" "%s" "restart"; return 0 ;;
      3|update-web) printf -v "$result_var" "%s" "update-web"; return 0 ;;
      4|update-all) printf -v "$result_var" "%s" "update-all"; return 0 ;;
      5|deploy) printf -v "$result_var" "%s" "deploy"; return 0 ;;
      0|exit|quit) printf -v "$result_var" "%s" "exit"; return 0 ;;
      *) echo "${indent}Invalid action, try again." >&2 ;;
    esac
  done
}

prompt_show_kind() {
  local result_var="$1"
  local indent="$2"
  local choice=""
  while true; do
    echo "${indent}Select show type: [1] process [2] log (default: process)" >&2
    if ! read_with_interrupt choice; then
      return 1
    fi
    choice="${choice//[[:space:]]/}"
    if [ "${INTERRUPTED:-0}" -eq 1 ]; then
      INTERRUPTED=0
      return 1
    fi
    case "${choice:-1}" in
      1|process) printf -v "$result_var" "%s" "process"; return 0 ;;
      2|log) printf -v "$result_var" "%s" "log"; return 0 ;;
      *) echo "${indent}Invalid show type, try again." >&2 ;;
    esac
  done
}

prompt_target() {
  local result_var="$1"
  local indent="$2"
  local choice=""
  while true; do
    echo "${indent}Select target: [1] server [2] web [3] all (default: server)" >&2
    if ! read_with_interrupt choice; then
      return 1
    fi
    choice="${choice//[[:space:]]/}"
    if [ "${INTERRUPTED:-0}" -eq 1 ]; then
      INTERRUPTED=0
      return 1
    fi
    case "${choice:-1}" in
      1|server) printf -v "$result_var" "%s" "server"; return 0 ;;
      2|web) printf -v "$result_var" "%s" "web"; return 0 ;;
      3|all) printf -v "$result_var" "%s" "all"; return 0 ;;
      *) echo "${indent}Invalid target, try again." >&2 ;;
    esac
  done
}

prompt_deploy_target() {
  local result_var="$1"
  local indent="$2"
  local choice=""
  while true; do
    echo "${indent}Select deploy target: [1] server [2] web (default: server)" >&2
    if ! read_with_interrupt choice; then
      return 1
    fi
    choice="${choice//[[:space:]]/}"
    if [ "${INTERRUPTED:-0}" -eq 1 ]; then
      INTERRUPTED=0
      return 1
    fi
    case "${choice:-1}" in
      1|server) printf -v "$result_var" "%s" "server"; return 0 ;;
      2|web) printf -v "$result_var" "%s" "web"; return 0 ;;
      *) echo "${indent}Invalid target, try again." >&2 ;;
    esac
  done
}

prompt_model() {
  local result_var="$1"
  local indent="$2"
  local choice=""
  local default_model=""
  local model_list=""
  default_model="$(default_main_model)"
  model_list="$(model_config_keys | paste -sd "," -)"
  while true; do
    if [ -n "$model_list" ]; then
      echo "${indent}Available main models: ${model_list}" >&2
    fi
    echo "${indent}Select main model (default: ${default_model})" >&2
    if ! read_with_interrupt choice; then
      return 1
    fi
    choice="${choice//[[:space:]]/}"
    if [ "${INTERRUPTED:-0}" -eq 1 ]; then
      INTERRUPTED=0
      return 1
    fi
    choice="${choice:-$default_model}"
    if model_exists "$choice"; then
      printf -v "$result_var" "%s" "$choice"
      return 0
    fi
    echo "${indent}Invalid model, try again." >&2
  done
}

interactive_menu() {
  local primary=""
  if ! prompt_primary_action primary "$INDENT_L1"; then
    return 1
  fi
  case "$primary" in
    exit)
      echo "Exit."
      exit 0
      ;;
    show)
      if ! prompt_show_kind ACTION "$INDENT_L2"; then
        return 1
      fi
      if ! prompt_target TARGET "$INDENT_L3"; then
        return 1
      fi
      MODEL=""
      ;;
    restart)
      ACTION="restart"
      TARGET="server"
      if ! prompt_model MODEL "$INDENT_L3"; then
        return 1
      fi
      ;;
    deploy)
      ACTION="deploy"
      if ! prompt_deploy_target TARGET "$INDENT_L2"; then
        return 1
      fi
      if [ "$TARGET" = "server" ] || [ "$TARGET" = "all" ]; then
        if ! prompt_model MODEL "$INDENT_L3"; then
          return 1
        fi
      else
        MODEL=""
      fi
      ;;
    update-web)
      ACTION="update-web"
      TARGET="web"
      MODEL=""
      ;;
    update-all)
      ACTION="update-all"
      TARGET="all"
      if ! prompt_model MODEL "$INDENT_L3"; then
        return 1
      fi
      ;;
  esac
  return 0
}

ACTION=""
TARGET=""
MODEL=""
INTERRUPTED=0
INDENT_TOKEN="» "
INDENT_L1="${INDENT_TOKEN}"
INDENT_L2="${INDENT_L1}${INDENT_TOKEN}"
INDENT_L3="${INDENT_L2}${INDENT_TOKEN}"
READ_TIMEOUT=1
if [ "${BASH_VERSINFO[0]:-0}" -ge 4 ]; then
  READ_TIMEOUT="0.1"
fi

read_with_interrupt() {
  local result_var="$1"
  local input=""
  while true; do
    input=""
    if read -r -t "$READ_TIMEOUT" input; then
      printf -v "$result_var" "%s" "$input"
      return 0
    fi
    if [ "${INTERRUPTED:-0}" -eq 1 ]; then
      INTERRUPTED=0
      return 1
    fi
  done
}

if [ "$#" -gt 0 ]; then
  ACTION="$1"
  TARGET="${2:-}"
  MODEL="${3:-}"
  if [ -z "$TARGET" ]; then
    case "$ACTION" in
      start|stop|stop-server|restart) TARGET="server" ;;
      update-web) TARGET="web" ;;
      update-all) TARGET="all" ;;
      *) TARGET="all" ;;
    esac
  fi
  do_action
  exit 0
fi

enable_interactive_trap
while true; do
  ACTION=""
  TARGET=""
  MODEL=""
  if ! interactive_menu; then
    continue
  fi
  do_action
done
