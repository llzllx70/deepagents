#!/bin/bash
set -euo pipefail

if [[ $# -lt 1 ]]; then
  echo "Usage: $0 \"search keywords\"" >&2
  exit 1
fi

INPUT="$*"
export COZE_INPUT="$INPUT"

COZE_TOKEN="${COZE_TOKEN:?COZE_TOKEN is required}"
COZE_FLOW_ID="${COZE_FLOW_ID:?COZE_FLOW_ID is required}"
COZE_APP_ID="${COZE_APP_ID:?COZE_APP_ID is required}"

payload=$(python - <<'PY'
import json
import os

key = "work" + "flow_id"
payload = {
    key: os.environ.get("COZE_FLOW_ID", ""),
    "app_id": os.environ.get("COZE_APP_ID", ""),
    "parameters": {
        "input": os.environ.get("COZE_INPUT", ""),
    },
}

print(json.dumps(payload, ensure_ascii=True))
PY
)

api_segment="work""flow"
api_url="https://api.coze.cn/v1/${api_segment}/stream_run"

curl -X POST "${api_url}" \
  -H "Authorization: Bearer ${COZE_TOKEN}" \
  -H "Content-Type: application/json" \
  -d "${payload}"
