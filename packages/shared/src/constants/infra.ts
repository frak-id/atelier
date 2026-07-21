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
  /** The sandbox PVC is attached as a RAW BLOCK device (`volumeMode: Block`),
   * not a pre-mounted filesystem — under Kata this passes through as
   * virtio-blk, so the guest formats/mounts a native ext4 at `DATA` and
   * overlayfs gets real `trusted.overlay.*` semantics (no virtio-fs, no
   * `userxattr`). This is the in-guest device node path the pod's
   * `volumeDevices[].devicePath` requests; `sandbox-boot.sh` mkfs's it on
   * first boot (idempotent) and mounts it at `DATA`. */
  DATA_DEVICE: "/dev/atelier-data",
} as const;
