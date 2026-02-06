export const VM = {
  USER: "dev",
  HOME: "/home/dev",
  UID: "1000",
  GID: "1000",
  OWNER: "1000:1000",
  WORKSPACE_DIR: "/home/dev/workspace",
} as const;

export const PATHS = {
  SANDBOX_DIR: "/var/lib/sandbox",
  KERNEL_DIR: "/var/lib/sandbox/firecracker/kernels",
  ROOTFS_DIR: "/var/lib/sandbox/firecracker/rootfs",
  OVERLAY_DIR: "/var/lib/sandbox/overlays",
  SOCKET_DIR: "/var/lib/sandbox/sockets",
  LOG_DIR: "/var/log/sandbox",
  APP_DIR: "/opt/atelier",
  GIT_CACHE_DIR: "/var/lib/sandbox/git-cache",
  SECRETS_DIR: "/var/lib/sandbox/secrets",
} as const;

export const FIRECRACKER = {
  RELEASE_URL: "https://github.com/firecracker-microvm/firecracker/releases",
  S3_BUCKET: "https://s3.amazonaws.com/spec.ccfc.min",
  BINARY_PATH: "/usr/local/bin/firecracker",
} as const;

export const LVM = {
  VG_NAME: "sandbox-vg",
  THIN_POOL: "thin-pool",
  IMAGE_PREFIX: "image-",
  PREBUILD_PREFIX: "prebuild-",
  SANDBOX_PREFIX: "sandbox-",
} as const;

export const SSH_PROXY = {
  BINARY_PATH: "/usr/local/bin/sshpiper",
  CONFIG_DIR: "/var/lib/sandbox/sshpiper",
  PIPES_FILE: "/var/lib/sandbox/sshpiper/pipes.yaml",
  HOST_KEY: "/var/lib/sandbox/sshpiper/host_key",
} as const;

export const DEFAULTS = {
  VCPUS: 2,
  MEMORY_MB: 2048,
  MAX_SANDBOXES: 20,
  VOLUME_SIZE_GB: 50,
} as const;

export const REGISTRY = {
  STORAGE_DIR: "/var/lib/sandbox/registry/storage",
  PACKAGES_DIR: "/var/lib/sandbox/registry/packages",
  EVICTION_DAYS: 14,
} as const;

export const SHARED_STORAGE = {
  BINARIES_DIR: "/var/lib/sandbox/shared-binaries",
} as const;

export const CADDY = {
  ADMIN_API: "http://localhost:2019",
} as const;
