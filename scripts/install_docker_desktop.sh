#!/usr/bin/env bash
set -euo pipefail

PURGE_DATA=false
BACKUP_CONFLICTS=true

for arg in "$@"; do
  case "$arg" in
    --purge)
      PURGE_DATA=true
      ;;
    --no-backup)
      BACKUP_CONFLICTS=false
      ;;
    *)
      echo "Usage: $0 [--purge] [--no-backup]" >&2
      echo "  --purge      Remove Docker Desktop data directories (all images/containers/volumes)." >&2
      echo "  --no-backup  Do not move conflicting binaries to *.bak." >&2
      exit 1
      ;;
  esac
done

if ! command -v brew >/dev/null 2>&1; then
  echo "Homebrew not found. Please install Homebrew first." >&2
  exit 1
fi

echo "Stopping Docker Desktop if running..."
pkill -f Docker >/dev/null 2>&1 || true

echo "Uninstalling Docker Desktop cask (if present)..."
brew uninstall --cask docker-desktop >/dev/null 2>&1 || true

if $BACKUP_CONFLICTS; then
  echo "Backing up conflicting binaries (if any)..."
  TIMESTAMP="$(date +%Y%m%d%H%M%S)"
  CONFLICTS=(
    "/usr/local/bin/hub-tool"
    "/usr/local/bin/kubectl.docker"
    "/usr/local/bin/docker"
    "/usr/local/bin/docker-credential-desktop"
  )
  for path in "${CONFLICTS[@]}"; do
    if [[ -e "$path" ]]; then
      sudo mv "$path" "${path}.bak.${TIMESTAMP}"
    fi
  done
fi

echo "Removing Docker.app (if any)..."
sudo rm -rf /Applications/Docker.app

if $PURGE_DATA; then
  echo "Purging Docker Desktop data..."
  rm -rf ~/Library/Group\ Containers/group.com.docker/ \
         ~/Library/Containers/com.docker.docker/ \
         ~/Library/Application\ Support/Docker\ Desktop/ \
         ~/Library/Logs/Docker\ Desktop/

  sudo rm -f /Library/PrivilegedHelperTools/com.docker.vmnetd \
             /Library/PrivilegedHelperTools/com.docker.socket
fi

echo "Installing Docker Desktop via Homebrew..."
brew install --cask docker-desktop

echo "Clearing quarantine attribute (best effort)..."
sudo xattr -dr com.apple.quarantine /Applications/Docker.app >/dev/null 2>&1 || true

echo "Starting Docker Desktop..."
open -a Docker

echo "Done. Run 'docker info' after the engine starts."
