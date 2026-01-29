import {
  SHARED_BINARIES,
  SHARED_STORAGE,
  type SharedBinaryId,
} from "@frak-sandbox/shared/constants";
import { $ } from "bun";
import { config } from "../../shared/lib/config.ts";
import { createChildLogger } from "../../shared/lib/logger.ts";

const log = createChildLogger("shared-storage");

export const BINARIES_IMAGE_PATH = `${SHARED_STORAGE.BINARIES_DIR}.ext4`;

export interface BinaryInfo {
  id: SharedBinaryId;
  name: string;
  version: string;
  installed: boolean;
  sizeBytes?: number;
  path?: string;
}

export interface BinariesImageInfo {
  exists: boolean;
  sizeBytes?: number;
  builtAt?: string;
}

async function pathExists(path: string): Promise<boolean> {
  const result = await $`test -e ${path}`.quiet().nothrow();
  return result.exitCode === 0;
}

async function getDirSize(path: string): Promise<number> {
  const result = await $`du -sb ${path} 2>/dev/null | cut -f1`
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
      const installPath = `${SHARED_STORAGE.BINARIES_DIR}/${binary.binaryPath}`;

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

    const installPath = `${SHARED_STORAGE.BINARIES_DIR}/${binary.binaryPath}`;
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

    const installPath = `${SHARED_STORAGE.BINARIES_DIR}/${binary.binaryPath}`;
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

      await $`mkdir -p ${SHARED_STORAGE.BINARIES_DIR}`.quiet();
      const extractResult =
        await $`${binary.extractCommand.split(" ")[0]} ${binary.extractCommand.split(" ").slice(1).join(" ")} ${tempFile} -C ${SHARED_STORAGE.BINARIES_DIR}`
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
      await $`mkdir -p ${SHARED_STORAGE.BINARIES_DIR}/bin`.quiet().nothrow();
      if (id === "code-server") {
        await $`ln -sf ../${binary.binaryPath}/bin/code-server ${SHARED_STORAGE.BINARIES_DIR}/bin/code-server`
          .quiet()
          .nothrow();
      } else if (id === "opencode") {
        await $`ln -sf ../${binary.binaryPath} ${SHARED_STORAGE.BINARIES_DIR}/bin/opencode`
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

    const installPath = `${SHARED_STORAGE.BINARIES_DIR}/${binary.binaryPath}`;

    try {
      if (!(await pathExists(installPath))) {
        return { success: false, error: "Binary not installed" };
      }

      await $`rm -rf ${installPath}`.quiet();

      if (id === "code-server") {
        await $`rm -f ${SHARED_STORAGE.BINARIES_DIR}/bin/code-server`
          .quiet()
          .nothrow();
      } else if (id === "opencode") {
        await $`rm -f ${SHARED_STORAGE.BINARIES_DIR}/bin/opencode`
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
};
