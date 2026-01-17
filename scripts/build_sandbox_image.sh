#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
IMAGE_NAME="${DEEPAGENTS_DOCKER_IMAGE:-deepagents-sandbox:22.04}"
DOCKERFILE_PATH="${DOCKERFILE_PATH:-$ROOT_DIR/docker/sandbox.Dockerfile}"

if [[ ! -f "$DOCKERFILE_PATH" ]]; then
  echo "Dockerfile not found: $DOCKERFILE_PATH" >&2
  exit 1
fi

echo "Building Docker image: $IMAGE_NAME"
docker build -t "$IMAGE_NAME" -f "$DOCKERFILE_PATH" "$ROOT_DIR"
