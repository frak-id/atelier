#!/bin/bash
# Build and export a sandbox base image as ext4 filesystem
# Usage: ./build-image.sh <image-name> [output-dir]

set -euo pipefail

IMAGE_NAME="${1:-dev-base}"
OUTPUT_DIR="${2:-/var/lib/sandbox/firecracker/rootfs}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
IMAGE_DIR="$SCRIPT_DIR/$IMAGE_NAME"
TEMP_DIR=$(mktemp -d)
CONTAINER_NAME="sandbox-build-$IMAGE_NAME-$$"

cleanup() {
    echo "Cleaning up..."
    docker rm -f "$CONTAINER_NAME" 2>/dev/null || true
    rm -rf "$TEMP_DIR"
}
trap cleanup EXIT

if [ ! -d "$IMAGE_DIR" ]; then
    echo "Error: Image directory not found: $IMAGE_DIR"
    echo "Available images:"
    ls -1 "$SCRIPT_DIR" | grep -v "\.sh$" | grep -v "README"
    exit 1
fi

AGENT_SCRIPT="$SCRIPT_DIR/sandbox-agent.mjs"
if [ ! -f "$AGENT_SCRIPT" ]; then
    echo "Error: sandbox-agent.mjs not found at: $AGENT_SCRIPT"
    echo "Deploy with 'bun run deploy' first, or build manually:"
    echo "  cd packages/sandbox-agent && bun run build"
    exit 1
fi

echo "=== Building $IMAGE_NAME image ==="
echo "Image directory: $IMAGE_DIR"
echo "Output directory: $OUTPUT_DIR"

echo ""
echo "Step 1: Preparing build context..."
cp "$AGENT_SCRIPT" "$IMAGE_DIR/sandbox-agent.mjs"

echo ""
echo "Step 2: Building Docker image..."
docker build -t "frak-sandbox/$IMAGE_NAME" "$IMAGE_DIR"

rm -f "$IMAGE_DIR/sandbox-agent.mjs"

echo ""
echo "Step 3: Creating container..."
docker create --name "$CONTAINER_NAME" "frak-sandbox/$IMAGE_NAME"

echo ""
echo "Step 4: Exporting filesystem..."
ROOTFS_TAR="$TEMP_DIR/rootfs.tar"
docker export "$CONTAINER_NAME" -o "$ROOTFS_TAR"

echo ""
echo "Step 5: Creating ext4 image..."
mkdir -p "$OUTPUT_DIR"
OUTPUT_FILE="$OUTPUT_DIR/$IMAGE_NAME.ext4"

# Calculate size (rootfs + 500MB headroom)
TAR_SIZE=$(stat -f%z "$ROOTFS_TAR" 2>/dev/null || stat -c%s "$ROOTFS_TAR")
IMAGE_SIZE=$(( (TAR_SIZE / 1024 / 1024) + 500 ))
echo "Creating ${IMAGE_SIZE}MB ext4 image..."

# Create sparse file
dd if=/dev/zero of="$OUTPUT_FILE" bs=1M count=0 seek="$IMAGE_SIZE" 2>/dev/null

# Create ext4 filesystem
mkfs.ext4 -F -q "$OUTPUT_FILE"

echo ""
echo "Step 6: Extracting rootfs to image..."
MOUNT_POINT="$TEMP_DIR/mnt"
mkdir -p "$MOUNT_POINT"

# Mount the image (requires root on Linux, or fuse-ext2 on macOS)
if [ "$(uname)" = "Darwin" ]; then
    echo "Note: On macOS, you may need to manually extract to a Linux machine"
    echo "Alternatively, install fuse-ext2: brew install macfuse && brew install --cask fuse-ext2"
    
    # Try fuse-ext2 if available
    if command -v fuse-ext2 &> /dev/null; then
        fuse-ext2 -o rw+ "$OUTPUT_FILE" "$MOUNT_POINT"
        tar -xf "$ROOTFS_TAR" -C "$MOUNT_POINT"
        umount "$MOUNT_POINT"
    else
        # Just copy the tar file and instructions
        cp "$ROOTFS_TAR" "$OUTPUT_DIR/$IMAGE_NAME-rootfs.tar"
        echo ""
        echo "Tar file created at: $OUTPUT_DIR/$IMAGE_NAME-rootfs.tar"
        echo "To complete on Linux, run:"
        echo "  mount -o loop $OUTPUT_FILE /mnt"
        echo "  tar -xf $OUTPUT_DIR/$IMAGE_NAME-rootfs.tar -C /mnt"
        echo "  umount /mnt"
        exit 0
    fi
else
    # Linux - mount and extract
    sudo mount -o loop "$OUTPUT_FILE" "$MOUNT_POINT"
    sudo tar -xf "$ROOTFS_TAR" -C "$MOUNT_POINT"
    sudo umount "$MOUNT_POINT"
fi

echo ""
echo "=== Build complete ==="
echo "Image created: $OUTPUT_FILE"
echo "Size: $(du -h "$OUTPUT_FILE" | cut -f1)"

# Create symlink for default rootfs if this is dev-base
if [ "$IMAGE_NAME" = "dev-base" ]; then
    ln -sf "$IMAGE_NAME.ext4" "$OUTPUT_DIR/rootfs.ext4"
    echo "Symlink created: $OUTPUT_DIR/rootfs.ext4 -> $IMAGE_NAME.ext4"
fi
