import { $ } from "bun";
import type { SandboxPaths } from "../../infrastructure/firecracker/index.ts";
import {
  type NetworkAllocation,
  networkService,
} from "../../infrastructure/network/index.ts";
import {
  proxyService,
  SshPiperService,
} from "../../infrastructure/proxy/index.ts";
import { StorageService } from "../../infrastructure/storage/index.ts";
import { createChildLogger } from "../../shared/lib/logger.ts";
import { killProcess } from "../../shared/lib/shell.ts";

const log = createChildLogger("cleanup-coordinator");

interface CleanupResources {
  pid?: number;
  paths?: SandboxPaths;
  network?: NetworkAllocation;
}

export async function cleanupSandboxResources(
  sandboxId: string,
  resources: CleanupResources,
): Promise<void> {
  const { pid, paths, network } = resources;

  if (pid) {
    await killProcess(pid).catch((error) => {
      log.warn({ sandboxId, pid, error }, "Failed to kill sandbox process");
    });
  }

  if (paths) {
    await $`rm -f ${paths.socket} ${paths.vsock} ${paths.pid} ${paths.log}`
      .quiet()
      .nothrow();

    if (paths.useLvm) {
      await StorageService.deleteSandboxVolume(sandboxId).catch((error) => {
        log.warn({ sandboxId, error }, "Failed to delete sandbox volume");
      });
    } else {
      await $`rm -f ${paths.overlay}`.quiet().nothrow();
    }
  }

  if (network) {
    await networkService.deleteTap(network.tapDevice).catch((error) => {
      log.warn(
        { sandboxId, tapDevice: network.tapDevice, error },
        "Failed to delete TAP device",
      );
    });
    try {
      networkService.release(network.ipAddress);
    } catch (error) {
      log.warn(
        { sandboxId, ipAddress: network.ipAddress, error },
        "Release failed",
      );
    }
  }

  await proxyService.removeRoutes(sandboxId).catch((error) => {
    log.warn({ sandboxId, error }, "Failed to remove proxy routes");
  });
  await SshPiperService.removeRoute(sandboxId).catch((error) => {
    log.warn({ sandboxId, error }, "Failed to remove SSH route");
  });
}
