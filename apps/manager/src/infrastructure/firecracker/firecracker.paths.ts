import { config } from "../../shared/lib/config.ts";

export interface SandboxPaths {
  socket: string;
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
    socket: `${config.paths.SOCKET_DIR}/${sandboxId}.sock`,
    pid: `${config.paths.SOCKET_DIR}/${sandboxId}.pid`,
    log: `${config.paths.LOG_DIR}/${sandboxId}.log`,
    overlay: lvmVolumePath || `${config.paths.OVERLAY_DIR}/${sandboxId}.ext4`,
    kernel: `${config.paths.KERNEL_DIR}/vmlinux`,
    rootfs: `${config.paths.ROOTFS_DIR}/rootfs.ext4`,
    useLvm: !!lvmVolumePath,
  };
}

export function getSocketPath(sandboxId: string): string {
  return `${config.paths.SOCKET_DIR}/${sandboxId}.sock`;
}

export interface PrebuildSnapshotPaths {
  snapshotFile: string;
  memFile: string;
}

export function getPrebuildSnapshotPaths(
  workspaceId: string,
): PrebuildSnapshotPaths {
  const snapshotDir = `${config.paths.SANDBOX_DIR}/snapshots`;
  return {
    snapshotFile: `${snapshotDir}/prebuild-${workspaceId}.snap`,
    memFile: `${snapshotDir}/prebuild-${workspaceId}.mem`,
  };
}
