import { PATHS } from "@frak/atelier-shared/constants";

export interface SandboxPaths {
  socket: string;
  vsock: string;
  pid: string;
  log: string;
  overlay: string;
  kernel: string;
  rootfs: string;
  useLvm: boolean;
}

export function getSandboxPaths(
  sandboxId: string,
  lvmVolumePath?: string,
): SandboxPaths {
  return {
    socket: `${PATHS.SOCKET_DIR}/${sandboxId}.sock`,
    vsock: `${PATHS.SOCKET_DIR}/${sandboxId}.vsock`,
    pid: `${PATHS.SOCKET_DIR}/${sandboxId}.pid`,
    log: `${PATHS.LOG_DIR}/${sandboxId}.log`,
    overlay: lvmVolumePath || `${PATHS.OVERLAY_DIR}/${sandboxId}.ext4`,
    kernel: `${PATHS.KERNEL_DIR}/vmlinux`,
    rootfs: `${PATHS.ROOTFS_DIR}/rootfs.ext4`,
    useLvm: !!lvmVolumePath,
  };
}

export function getVsockPath(sandboxId: string): string {
  return `${PATHS.SOCKET_DIR}/${sandboxId}.vsock`;
}

export function getSocketPath(sandboxId: string): string {
  return `${PATHS.SOCKET_DIR}/${sandboxId}.sock`;
}

export interface PrebuildSnapshotPaths {
  snapshotFile: string;
  memFile: string;
}

export function getPrebuildSnapshotPaths(
  workspaceId: string,
): PrebuildSnapshotPaths {
  const snapshotDir = `${PATHS.SANDBOX_DIR}/snapshots`;
  return {
    snapshotFile: `${snapshotDir}/prebuild-${workspaceId}.snap`,
    memFile: `${snapshotDir}/prebuild-${workspaceId}.mem`,
  };
}
