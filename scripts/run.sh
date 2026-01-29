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
if [ ! -f "$MODEL_CONFIG_FILE" ]; then
  echo "Missing model config file: $MODEL_CONFIG_FILE" >&2
  exit 1
fi

usage() {
  echo "Usage: $0 [start|stop|restart|process|log] [all|server|web] [glm|qwen|claude]" >&2
}

validate_action() {
  case "$ACTION" in
    start|stop|restart|process|log) ;;
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

validate_model() {
  case "$MODEL" in
    glm|qwen|claude) ;;
    *)
      usage
      exit 1
      ;;
  esac
}

load_env_config() {
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

model_config_value() {
  local model="$1"
  local key="$2"
  python - "$MODEL_CONFIG_FILE" "$model" "$key" <<'PY'
import sys

path = sys.argv[1]
model = sys.argv[2]
key = sys.argv[3]

models = {}
current_section = None
current_model = None

with open(path, "r", encoding="utf-8") as handle:
    for raw_line in handle:
        line = raw_line.rstrip("\n")
        stripped = line.strip()
        if not stripped or stripped.startswith("#"):
            continue
        indent = len(line) - len(line.lstrip(" "))
        if indent == 0:
            current_section = stripped.rstrip(":")
            current_model = None
            continue
        if current_section != "models":
            continue
        if indent == 2 and stripped.endswith(":"):
            current_model = stripped[:-1].strip()
            models.setdefault(current_model, {})
            continue
        if indent == 4 and ":" in stripped and current_model:
            raw_key, raw_value = stripped.split(":", 1)
            value = raw_value.strip()
            if (value.startswith('"') and value.endswith('"')) or (value.startswith("'") and value.endswith("'")):
                value = value[1:-1]
            models[current_model][raw_key.strip()] = value

sys.stdout.write(models.get(model, {}).get(key, ""))
PY
}

set_model_env() {
  local api_key=""
  local base_url=""
  local model_name=""
  local langchain_project=""

  api_key="$(model_config_value "$MODEL" "api_key")"
  base_url="$(model_config_value "$MODEL" "base_url")"
  model_name="$(model_config_value "$MODEL" "model")"
  langchain_project="$(model_config_value "$MODEL" "langchain_project")"

  if [ -z "$api_key" ] || [ -z "$base_url" ] || [ -z "$model_name" ]; then
    echo "Missing model config for $MODEL in $MODEL_CONFIG_FILE" >&2
    exit 1
  fi

  export OPENAI_API_KEY="$api_key"
  export OPENAI_BASE_URL="$base_url"
  export OPENAI_MODEL="$model_name"
  export LANGCHAIN_PROJECT="$langchain_project"
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

stop_web() {
  echo "Stopping web..."
  pkill -f "python -m http.server 8080" >/dev/null 2>&1 || true
}

start_server() {
  ensure_logs
  export_env_config
  set_model_env
  echo "Starting server (model=$MODEL, openai_model=$OPENAI_MODEL)..."
  start_detached "Server" "logs/server.log" python -m server.deepagents_server
}

start_web() {
  ensure_logs
  echo "Starting web..."
  start_detached "Web" "logs/web.log" bash -c 'cd web && exec python web_server.py 8080'
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
  if pgrep -f "python -m http.server 8080" >/dev/null 2>&1; then
    while read -r pid; do
      cmd="$(ps -p "$pid" -o command=)"
      echo "  pid=$pid cmd=$cmd"
    done < <(pgrep -f "python -m http.server 8080")
  else
    echo "  not running"
  fi
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
  if [ -f logs/web.log ]; then
    files+=("logs/web.log")
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
  if [ "$TARGET" = "all" ] || [ "$TARGET" = "web" ]; then
    start_web
  fi
}

do_stop() {
  if [ "$TARGET" = "all" ] || [ "$TARGET" = "server" ]; then
    stop_server
  fi
  if [ "$TARGET" = "all" ] || [ "$TARGET" = "web" ]; then
    stop_web
  fi
}

do_action() {
  validate_action
  validate_target
  validate_model

  case "$ACTION" in
    start)
      do_start
      ;;
    stop)
      do_stop
      ;;
    restart)
      do_stop
      do_start
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
        follow_log_file "Web Log" "logs/web.log"
      fi
      ;;
  esac

  echo "Done: action=$ACTION target=$TARGET model=$MODEL"
}

prompt_primary_action() {
  local result_var="$1"
  local indent="$2"
  local choice=""
  while true; do
    echo "${indent}Select action: [1] show [2] restart [3] start [4] stop [0] exit (default: show)" >&2
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
      2|restart) printf -v "$result_var" "%s" "restart"; return 0 ;;
      3|start) printf -v "$result_var" "%s" "start"; return 0 ;;
      4|stop) printf -v "$result_var" "%s" "stop"; return 0 ;;
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

prompt_model() {
  local result_var="$1"
  local indent="$2"
  local choice=""
  while true; do
    echo "${indent}Select model: [1] glm [2] qwen [3] claude (default: glm)" >&2
    if ! read_with_interrupt choice; then
      return 1
    fi
    choice="${choice//[[:space:]]/}"
    if [ "${INTERRUPTED:-0}" -eq 1 ]; then
      INTERRUPTED=0
      return 1
    fi
    case "${choice:-1}" in
      1|glm) printf -v "$result_var" "%s" "glm"; return 0 ;;
      2|qwen) printf -v "$result_var" "%s" "qwen"; return 0 ;;
      3|claude) printf -v "$result_var" "%s" "claude"; return 0 ;;
      *) echo "${indent}Invalid model, try again." >&2 ;;
    esac
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
      MODEL="glm"
      ;;
    restart|start)
      ACTION="$primary"
      if ! prompt_target TARGET "$INDENT_L2"; then
        return 1
      fi
      if ! prompt_model MODEL "$INDENT_L3"; then
        return 1
      fi
      ;;
    stop)
      ACTION="stop"
      if ! prompt_target TARGET "$INDENT_L2"; then
        return 1
      fi
      MODEL="glm"
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
  TARGET="${2:-all}"
  MODEL="${3:-glm}"
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
