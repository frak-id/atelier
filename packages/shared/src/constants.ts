/**
 * Shared constants for Frak Sandbox infrastructure
 */

export const PATHS = {
  /** Main data directory */
  SANDBOX_DIR: "/var/lib/sandbox",
  /** Pre-built kernels */
  KERNEL_DIR: "/var/lib/sandbox/firecracker/kernels",
  /** Rootfs images */
  ROOTFS_DIR: "/var/lib/sandbox/firecracker/rootfs",
  /** Per-sandbox writable layers */
  OVERLAY_DIR: "/var/lib/sandbox/overlays",
  /** Firecracker API sockets */
  SOCKET_DIR: "/var/lib/sandbox/sockets",
  /** Application logs */
  LOG_DIR: "/var/log/sandbox",
  /** Application code */
  APP_DIR: "/opt/frak-sandbox",
  /** Git repository cache */
  GIT_CACHE_DIR: "/var/lib/sandbox/git-cache",
  /** Encrypted secrets */
  SECRETS_DIR: "/var/lib/sandbox/secrets",
} as const;

export const FIRECRACKER = {
  VERSION: "1.10.1",
  RELEASE_URL: "https://github.com/firecracker-microvm/firecracker/releases",
  S3_BUCKET: "https://s3.amazonaws.com/spec.ccfc.min",
  /** Path to firecracker binary */
  BINARY_PATH: "/usr/local/bin/firecracker",
} as const;

export const NETWORK = {
  /** Bridge device name */
  BRIDGE_NAME: "br0",
  /** Bridge IP address */
  BRIDGE_IP: "172.16.0.1",
  /** Bridge CIDR notation */
  BRIDGE_CIDR: "172.16.0.0/24",
  /** Bridge netmask */
  BRIDGE_NETMASK: "24",
  /** First guest IP (last octet) */
  GUEST_IP_START: 10,
  /** Guest subnet prefix */
  GUEST_SUBNET: "172.16.0",
  /** Test VM IP */
  TEST_VM_IP: "172.16.0.2",
  /** Test VM MAC address */
  TEST_VM_MAC: "06:00:AC:10:00:02",
  /** Test TAP device name */
  TEST_TAP: "tap-test",
} as const;

export const LVM = {
  /** Volume group name */
  VG_NAME: "sandbox-vg",
  /** Thin pool name */
  THIN_POOL: "thin-pool",
  /** Base volume name (legacy, use image volumes) */
  BASE_VOLUME: "base-rootfs",
  /** Base volume size (legacy) */
  BASE_SIZE: "2G",
  /** Image volume prefix */
  IMAGE_PREFIX: "image-",
  /** Prebuild volume prefix */
  PREBUILD_PREFIX: "prebuild-",
  /** Sandbox volume prefix */
  SANDBOX_PREFIX: "sandbox-",
} as const;

export const CADDY = {
  /** Caddy admin API endpoint */
  ADMIN_API: "http://localhost:2019",
  /** Default sandbox domain suffix */
  DOMAIN_SUFFIX: "sandbox.frak.dev",
} as const;

export const DEFAULTS = {
  /** Default vCPU count for sandboxes */
  VCPUS: 2,
  /** Default memory in MB */
  MEMORY_MB: 2048,
  /** Maximum sandboxes per host (based on 64GB RAM) */
  MAX_SANDBOXES: 20,
  /** Sandbox boot timeout in ms */
  BOOT_TIMEOUT_MS: 30000,
} as const;
