export const VM = {
  USER: "dev",
  HOME: "/home/dev",
  UID: "1000",
  GID: "1000",
  OWNER: "1000:1000",
  WORKSPACE_DIR: "/home/dev/workspace",
  /** Where the sandbox PVC mounts (toolset-overlay-squashfs.md §3) — NOT
   * `HOME` anymore. `HOME` is an overlay: skel + toolset squashfs blobs as
   * read-only lowers, `DATA_UPPER`/`DATA_WORK` as the writable upper. */
  DATA: "/data",
  DATA_UPPER: "/data/upper",
  DATA_WORK: "/data/work",
  DATA_TOOLSETS: "/data/toolsets",
} as const;

export const PATHS = {
  APP_DIR: "/opt/atelier",
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
  MOUNT_PATH: "/opt/shared",
  BIN_DIR: "/opt/shared/bin",
} as const;
