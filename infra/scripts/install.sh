#!/usr/bin/env bash
set -euo pipefail

REPO="${FRAK_REPO:-frak-id/oc-sandbox}"
VERSION="${FRAK_VERSION:-}"
CLI_NAME="frak-sandbox"
CLI_PATH="/usr/local/bin/${CLI_NAME}"

if [ "$(id -u)" -ne 0 ]; then
  echo "Please run as root (sudo -s)." >&2
  exit 1
fi

if [ -f /etc/os-release ]; then
  # shellcheck disable=SC1091
  . /etc/os-release
  if [ "${ID:-}" != "debian" ]; then
    echo "Unsupported distro: ${ID:-unknown}. Debian required." >&2
    exit 1
  fi
else
  echo "/etc/os-release not found. Cannot verify distro." >&2
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

if [ ! -c /dev/kvm ]; then
  echo "/dev/kvm not found. Ensure KVM is enabled and this is bare metal." >&2
  exit 1
fi

echo "Installing prerequisites..."
apt-get update -qq
DEBIAN_FRONTEND=noninteractive apt-get install -y -qq curl ca-certificates sudo jq

if [ -z "$VERSION" ]; then
  echo "Fetching latest release..."
  VERSION="$(curl -fsSL "https://api.github.com/repos/${REPO}/releases/latest" | jq -r '.tag_name')"
fi

if [ -z "$VERSION" ] || [ "$VERSION" = "null" ]; then
  echo "Could not determine release version." >&2
  exit 1
fi

CLI_URL="https://github.com/${REPO}/releases/download/${VERSION}/frak-sandbox-linux-x64"

echo "Downloading CLI ${VERSION}..."
curl -fsSL "$CLI_URL" -o "$CLI_PATH"
chmod +x "$CLI_PATH"

echo ""
echo "Running installer..."
"$CLI_PATH" init

echo ""
echo "Install complete."
