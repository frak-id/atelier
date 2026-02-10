#!/usr/bin/env bash
set -euo pipefail

REPO="${ATELIER_REPO:-frak-id/atelier}"
VERSION="${ATELIER_VERSION:-}"
CLI_NAME="atelier"
CLI_PATH="/usr/local/bin/${CLI_NAME}"

if [ "$(id -u)" -ne 0 ]; then
  echo "Please run as root (sudo -s)." >&2
  exit 1
fi

ARCH="$(uname -m)"
if [ "$ARCH" != "x86_64" ]; then
  echo "Unsupported architecture: $ARCH (x86_64 required)." >&2
  exit 1
fi

if ! command -v systemctl >/dev/null 2>&1; then
  echo "systemd is required (systemctl not found)." >&2
  exit 1
fi

if ! command -v apt-get >/dev/null 2>&1; then
  echo "apt package manager is required (apt-get not found)." >&2
  exit 1
fi

if [ ! -c /dev/kvm ]; then
  echo "/dev/kvm not found. Ensure KVM is enabled and this is bare metal." >&2
  exit 1
fi

echo "Installing prerequisites..."
apt-get update -qq
DEBIAN_FRONTEND=noninteractive apt-get install -y -qq curl ca-certificates sudo jq lvm2

if ! command -v lvm >/dev/null 2>&1; then
  echo "LVM is required but lvm2 failed to install." >&2
  exit 1
fi

if [ -z "$VERSION" ]; then
  echo "Fetching latest release..."
  VERSION="$(curl -fsSL "https://api.github.com/repos/${REPO}/releases/latest" | jq -r '.tag_name')"
fi

if [ -z "$VERSION" ] || [ "$VERSION" = "null" ]; then
  echo "Could not determine release version." >&2
  exit 1
fi

CLI_URL="https://github.com/${REPO}/releases/download/${VERSION}/atelier-linux-x64"

echo "Downloading CLI ${VERSION}..."
curl -fsSL "$CLI_URL" -o "$CLI_PATH"
chmod +x "$CLI_PATH"

echo ""
echo "Running installer..."
"$CLI_PATH" init

echo ""
echo "Install complete."
