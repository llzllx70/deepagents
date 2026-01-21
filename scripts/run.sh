#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
cd "$ROOT_DIR"

CONFIG_FILE="${SCRIPT_DIR}/run_config.sh"
if [ -f "$CONFIG_FILE" ]; then
  # shellcheck source=/dev/null
  . "$CONFIG_FILE"
else
  echo "Missing config file: $CONFIG_FILE" >&2
  exit 1
fi

usage() {
  echo "Usage: $0 [start|stop|restart|process|log] [all|server|web] [glm|qwen]" >&2
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
    glm|qwen) ;;
    *)
      usage
      exit 1
      ;;
  esac
}

set_model_env() {
  case "$MODEL" in
    glm)
      export OPENAI_API_KEY="$GLM_OPENAI_API_KEY"
      export OPENAI_BASE_URL="$GLM_OPENAI_BASE_URL"
      export OPENAI_MODEL="$GLM_OPENAI_MODEL"
      export LANGCHAIN_PROJECT="$GLM_LANGCHAIN_PROJECT"
      ;;
    qwen)
      export OPENAI_API_KEY="$QWEN_OPENAI_API_KEY"
      export OPENAI_BASE_URL="$QWEN_OPENAI_BASE_URL"
      export OPENAI_MODEL="$QWEN_OPENAI_MODEL"
      export LANGCHAIN_PROJECT="$QWEN_LANGCHAIN_PROJECT"
      ;;
  esac
}

ensure_logs() {
  mkdir -p logs
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
  set_model_env
  echo "Starting server (model=$MODEL, openai_model=$OPENAI_MODEL)..."
  nohup python -m server.deepagents_server > logs/server.log 2>&1 &
  echo "Server started: pid=$!"
}

start_web() {
  ensure_logs
  echo "Starting web..."
  (
    cd web
    nohup python -m http.server 8080 > ../logs/web.log 2>&1 &
    echo "Web started: pid=$!"
  )
}

print_header() {
  echo "【$1】"
}

print_model_config() {
  print_header "Model Config"
  echo "  glm: OPENAI_MODEL=$GLM_OPENAI_MODEL"
  echo "       OPENAI_BASE_URL=$GLM_OPENAI_BASE_URL"
  echo "       LANGCHAIN_PROJECT=$GLM_LANGCHAIN_PROJECT"
  echo "  qwen: OPENAI_MODEL=$QWEN_OPENAI_MODEL"
  echo "        OPENAI_BASE_URL=$QWEN_OPENAI_BASE_URL"
  echo "        LANGCHAIN_PROJECT=$QWEN_LANGCHAIN_PROJECT"
}

interactive_interrupt() {
  echo
  print_header "提示"
  echo "已返回主菜单"
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
  print_model_config
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

prompt_action() {
  while true; do
    echo "Select action: [1] start [2] stop [3] restart [4] show process [5] show log (default: start)"
    read -r choice || true
    case "${choice:-1}" in
      1|start) echo "start"; return ;;
      2|stop) echo "stop"; return ;;
      3|restart) echo "restart"; return ;;
      4|process) echo "process"; return ;;
      5|log) echo "log"; return ;;
      *) echo "Invalid action, try again." ;;
    esac
  done
}

prompt_target() {
  while true; do
    echo "Select target: [1] all [2] server [3] web (default: all)"
    read -r choice || true
    case "${choice:-1}" in
      1|all) echo "all"; return ;;
      2|server) echo "server"; return ;;
      3|web) echo "web"; return ;;
      *) echo "Invalid target, try again." ;;
    esac
  done
}

prompt_model() {
  while true; do
    echo "Select model: [1] glm [2] qwen (default: glm)"
    read -r choice || true
    case "${choice:-1}" in
      1|glm) echo "glm"; return ;;
      2|qwen) echo "qwen"; return ;;
      *) echo "Invalid model, try again." ;;
    esac
  done
}

interactive_menu() {
  cat <<'EOF'
Select a quick action:
  1) start all (glm)
  2) start all (qwen)
  3) restart all (glm)
  4) restart all (qwen)
  5) stop all
  6) start server (glm)
  7) start server (qwen)
  8) restart server (glm)
  9) restart server (qwen)
 10) stop server
 11) start web
 12) restart web
 13) stop web
 14) show process (all)
 15) show process (server)
 16) show process (web)
 17) show log (all)
 18) show log (server)
 19) show log (web)
 20) custom
  0) exit
EOF

  while true; do
    read -r -p "Choice: " choice || true
    case "$choice" in
      1) ACTION="start"; TARGET="all"; MODEL="glm"; break ;;
      2) ACTION="start"; TARGET="all"; MODEL="qwen"; break ;;
      3) ACTION="restart"; TARGET="all"; MODEL="glm"; break ;;
      4) ACTION="restart"; TARGET="all"; MODEL="qwen"; break ;;
      5) ACTION="stop"; TARGET="all"; MODEL="glm"; break ;;
      6) ACTION="start"; TARGET="server"; MODEL="glm"; break ;;
      7) ACTION="start"; TARGET="server"; MODEL="qwen"; break ;;
      8) ACTION="restart"; TARGET="server"; MODEL="glm"; break ;;
      9) ACTION="restart"; TARGET="server"; MODEL="qwen"; break ;;
      10) ACTION="stop"; TARGET="server"; MODEL="glm"; break ;;
      11) ACTION="start"; TARGET="web"; MODEL="glm"; break ;;
      12) ACTION="restart"; TARGET="web"; MODEL="glm"; break ;;
      13) ACTION="stop"; TARGET="web"; MODEL="glm"; break ;;
      14) ACTION="process"; TARGET="all"; MODEL="glm"; break ;;
      15) ACTION="process"; TARGET="server"; MODEL="glm"; break ;;
      16) ACTION="process"; TARGET="web"; MODEL="glm"; break ;;
      17) ACTION="log"; TARGET="all"; MODEL="glm"; break ;;
      18) ACTION="log"; TARGET="server"; MODEL="glm"; break ;;
      19) ACTION="log"; TARGET="web"; MODEL="glm"; break ;;
      20)
        ACTION="$(prompt_action)"
        TARGET="$(prompt_target)"
        MODEL="$(prompt_model)"
        break
        ;;
      0|exit|quit)
        echo "Exit."
        exit 0
        ;;
      *)
        echo "Invalid choice, try again."
        ;;
    esac
  done
}

ACTION=""
TARGET=""
MODEL=""

if [ "$#" -gt 0 ]; then
  ACTION="$1"
  TARGET="${2:-all}"
  MODEL="${3:-glm}"
  do_action
  exit 0
fi

enable_interactive_trap
while true; do
  interactive_menu
  do_action
done
