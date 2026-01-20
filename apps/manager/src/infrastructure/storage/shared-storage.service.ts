import {
  NFS,
  SHARED_BINARIES,
  type SharedBinaryId,
} from "@frak-sandbox/shared/constants";
import { $ } from "bun";
import { config } from "../../shared/lib/config.ts";
import { createChildLogger } from "../../shared/lib/logger.ts";

const log = createChildLogger("shared-storage");

export interface BinaryInfo {
  id: SharedBinaryId;
  name: string;
  version: string;
  installed: boolean;
  sizeBytes?: number;
  path?: string;
}

export interface CacheFolderInfo {
  name: string;
  sizeBytes: number;
  fileCount: number;
}

export interface CacheInfo {
  totalSizeBytes: number;
  folders: CacheFolderInfo[];
}

async function pathExists(path: string): Promise<boolean> {
  const result = await $`test -e ${path}`.quiet().nothrow();
  return result.exitCode === 0;
}

async function dirExists(path: string): Promise<boolean> {
  const result = await $`test -d ${path}`.quiet().nothrow();
  return result.exitCode === 0;
}

async function getDirSize(path: string): Promise<number> {
  const result = await $`du -sb ${path} 2>/dev/null | cut -f1`
    .quiet()
    .nothrow();
  if (result.exitCode !== 0) return 0;
  return Number.parseInt(result.stdout.toString().trim(), 10) || 0;
}

async function getFileCount(path: string): Promise<number> {
  const result = await $`find ${path} -type f 2>/dev/null | wc -l`
    .quiet()
    .nothrow();
  if (result.exitCode !== 0) return 0;
  return Number.parseInt(result.stdout.toString().trim(), 10) || 0;
}

export const SharedStorageService = {
  async listBinaries(): Promise<BinaryInfo[]> {
    const results: BinaryInfo[] = [];

    for (const [id, binary] of Object.entries(SHARED_BINARIES)) {
      const binaryId = id as SharedBinaryId;
      const installPath = `${NFS.BINARIES_EXPORT_DIR}/${binary.binaryPath}`;

      let installed = false;
      let sizeBytes: number | undefined;

      if (config.isMock()) {
        installed = binaryId === "opencode";
        sizeBytes = installed
          ? binary.estimatedSizeMb * 1024 * 1024
          : undefined;
      } else {
        installed = await pathExists(installPath);
        if (installed) {
          sizeBytes = await getDirSize(installPath);
        }
      }

      results.push({
        id: binaryId,
        name: binary.name,
        version: binary.version,
        installed,
        sizeBytes,
        path: installed ? installPath : undefined,
      });
    }

    return results;
  },

  async getBinary(id: SharedBinaryId): Promise<BinaryInfo | null> {
    const binary = SHARED_BINARIES[id];
    if (!binary) return null;

    const installPath = `${NFS.BINARIES_EXPORT_DIR}/${binary.binaryPath}`;
    let installed = false;
    let sizeBytes: number | undefined;

    if (config.isMock()) {
      installed = id === "opencode";
      sizeBytes = installed ? binary.estimatedSizeMb * 1024 * 1024 : undefined;
    } else {
      installed = await pathExists(installPath);
      if (installed) {
        sizeBytes = await getDirSize(installPath);
      }
    }

    return {
      id,
      name: binary.name,
      version: binary.version,
      installed,
      sizeBytes,
      path: installed ? installPath : undefined,
    };
  },

  async installBinary(
    id: SharedBinaryId,
  ): Promise<{ success: boolean; error?: string }> {
    const binary = SHARED_BINARIES[id];
    if (!binary) {
      return { success: false, error: `Unknown binary: ${id}` };
    }

    if (config.isMock()) {
      log.info({ id, version: binary.version }, "Mock: Installing binary");
      return { success: true };
    }

    const installPath = `${NFS.BINARIES_EXPORT_DIR}/${binary.binaryPath}`;
    const tempFile = `/tmp/${id}-${binary.version}.tar.gz`;

    try {
      log.info({ id, url: binary.url }, "Downloading binary");

      const downloadResult = await $`curl -fsSL -o ${tempFile} ${binary.url}`
        .quiet()
        .nothrow();
      if (downloadResult.exitCode !== 0) {
        return {
          success: false,
          error: `Download failed: ${downloadResult.stderr.toString()}`,
        };
      }

      log.info({ id, tempFile }, "Extracting binary");

      await $`mkdir -p ${NFS.BINARIES_EXPORT_DIR}`.quiet();
      const extractResult =
        await $`${binary.extractCommand.split(" ")[0]} ${binary.extractCommand.split(" ").slice(1).join(" ")} ${tempFile} -C ${NFS.BINARIES_EXPORT_DIR}`
          .quiet()
          .nothrow();
      if (extractResult.exitCode !== 0) {
        return {
          success: false,
          error: `Extract failed: ${extractResult.stderr.toString()}`,
        };
      }

      await $`rm -f ${tempFile}`.quiet().nothrow();

      // Create relative symlinks so they work from VM's /opt/shared/bin/
      // (absolute paths would point to host filesystem, not guest)
      await $`mkdir -p ${NFS.BINARIES_EXPORT_DIR}/bin`.quiet().nothrow();
      if (id === "code-server") {
        await $`ln -sf ../${binary.binaryPath}/bin/code-server ${NFS.BINARIES_EXPORT_DIR}/bin/code-server`
          .quiet()
          .nothrow();
      } else if (id === "opencode") {
        await $`ln -sf ../${binary.binaryPath} ${NFS.BINARIES_EXPORT_DIR}/bin/opencode`
          .quiet()
          .nothrow();
      }

      log.info({ id, installPath }, "Binary installed successfully");
      return { success: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log.error({ id, error: message }, "Failed to install binary");
      return { success: false, error: message };
    }
  },

  async removeBinary(
    id: SharedBinaryId,
  ): Promise<{ success: boolean; error?: string }> {
    const binary = SHARED_BINARIES[id];
    if (!binary) {
      return { success: false, error: `Unknown binary: ${id}` };
    }

    if (config.isMock()) {
      log.info({ id }, "Mock: Removing binary");
      return { success: true };
    }

    const installPath = `${NFS.BINARIES_EXPORT_DIR}/${binary.binaryPath}`;

    try {
      if (!(await pathExists(installPath))) {
        return { success: false, error: "Binary not installed" };
      }

      await $`rm -rf ${installPath}`.quiet();

      if (id === "code-server") {
        await $`rm -f ${NFS.BINARIES_EXPORT_DIR}/bin/code-server`
          .quiet()
          .nothrow();
      } else if (id === "opencode") {
        await $`rm -f ${NFS.BINARIES_EXPORT_DIR}/bin/opencode`
          .quiet()
          .nothrow();
      }

      log.info({ id }, "Binary removed");
      return { success: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log.error({ id, error: message }, "Failed to remove binary");
      return { success: false, error: message };
    }
  },

  async getCacheInfo(): Promise<CacheInfo> {
    if (config.isMock()) {
      return {
        totalSizeBytes: 1024 * 1024 * 150,
        folders: [
          { name: "bun", sizeBytes: 1024 * 1024 * 80, fileCount: 245 },
          { name: "npm", sizeBytes: 1024 * 1024 * 50, fileCount: 123 },
          { name: "pip", sizeBytes: 1024 * 1024 * 20, fileCount: 45 },
          { name: "pnpm", sizeBytes: 0, fileCount: 0 },
          { name: "yarn", sizeBytes: 0, fileCount: 0 },
        ],
      };
    }

    const folders: CacheFolderInfo[] = [];
    let totalSizeBytes = 0;

    for (const folderName of Object.values(NFS.CACHE_DIRS)) {
      const folderPath = `${NFS.CACHE_EXPORT_DIR}/${folderName}`;
      const sizeBytes = await getDirSize(folderPath);
      const fileCount = await getFileCount(folderPath);

      folders.push({ name: folderName, sizeBytes, fileCount });
      totalSizeBytes += sizeBytes;
    }

    return { totalSizeBytes, folders };
  },

  async purgeCache(
    folderName: string,
  ): Promise<{ success: boolean; freedBytes: number; error?: string }> {
    const validFolders = Object.values(NFS.CACHE_DIRS);
    if (!validFolders.includes(folderName as (typeof validFolders)[number])) {
      return {
        success: false,
        freedBytes: 0,
        error: `Invalid cache folder: ${folderName}`,
      };
    }

    if (config.isMock()) {
      log.info({ folder: folderName }, "Mock: Purging cache folder");
      return { success: true, freedBytes: 1024 * 1024 * 50 };
    }

    const folderPath = `${NFS.CACHE_EXPORT_DIR}/${folderName}`;

    try {
      const sizeBefore = await getDirSize(folderPath);

      await $`rm -rf ${folderPath}/*`.quiet().nothrow();

      const freedBytes = sizeBefore;
      log.info({ folder: folderName, freedBytes }, "Cache folder purged");
      return { success: true, freedBytes };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log.error(
        { folder: folderName, error: message },
        "Failed to purge cache",
      );
      return { success: false, freedBytes: 0, error: message };
    }
  },

  async getNfsStatus(): Promise<{
    cacheExportExists: boolean;
    binariesExportExists: boolean;
    nfsServerRunning: boolean;
  }> {
    if (config.isMock()) {
      return {
        cacheExportExists: true,
        binariesExportExists: true,
        nfsServerRunning: true,
      };
    }

    const [cacheExists, binariesExists, nfsStatus] = await Promise.all([
      dirExists(NFS.CACHE_EXPORT_DIR),
      dirExists(NFS.BINARIES_EXPORT_DIR),
      $`systemctl is-active nfs-kernel-server`.quiet().nothrow(),
    ]);

    return {
      cacheExportExists: cacheExists,
      binariesExportExists: binariesExists,
      nfsServerRunning: nfsStatus.exitCode === 0,
    };
  },
};
