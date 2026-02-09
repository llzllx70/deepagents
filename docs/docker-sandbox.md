# Docker Sandbox

This project can run agent execution in Docker-based sandboxes with a warm pool.

## Image Build

Build the sandbox image (Ubuntu 22.04 + python3/pip/uv/apt/vim/node + Playwright Chromium):

```bash
scripts/build_sandbox_image.sh
```

This image configures pip to use CN mirrors by default (Tsinghua as primary, USTC as extra), and upgrades pip during build.
You can override mirrors via env vars passed as Docker build args:

```bash
PIP_INDEX_URL=https://pypi.tuna.tsinghua.edu.cn/simple/ \
PIP_EXTRA_INDEX_URL=https://pypi.mirrors.ustc.edu.cn/simple/ \
scripts/build_sandbox_image.sh
```

Override the image name or Dockerfile path:

```bash
DEEPAGENTS_DOCKER_IMAGE=deepagents-sandbox:22.04 DOCKERFILE_PATH=./docker/sandbox.Dockerfile scripts/build_sandbox_image.sh
```

## Server Configuration

Environment variables:

- `DEEPAGENTS_DOCKER_IMAGE` (default: `deepagents-sandbox:22.04`)
- `DEEPAGENTS_DOCKER_POOL_SIZE` (default: `10`)
- `DEEPAGENTS_DOCKER_MIN_IDLE` (default: `2`)
- `DEEPAGENTS_DOCKER_WORKDIR` (default: `/workspace`)
- `DEEPAGENTS_DOCKER_CPUS` (optional)
- `DEEPAGENTS_DOCKER_MEMORY` (optional)
- `DEEPAGENTS_DOCKER_PIDS_LIMIT` (optional)

## Session Lifecycle

- Each session maps to `workspace/<session_id>/` on the server.
- On `DELETE /sessions/{session_id}`, the container `/workspace` is copied to that directory.
- Containers are only released when the user deletes a chat from the web UI.
