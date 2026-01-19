import { $ } from "bun";
import { getSocketPath } from "../infrastructure/firecracker/index.ts";
import { NetworkService } from "../infrastructure/network/index.ts";
import { CaddyService } from "../infrastructure/proxy/index.ts";
import { StorageService } from "../infrastructure/storage/index.ts";
import type { SandboxService } from "../modules/sandbox/index.ts";
import { NotFoundError } from "../shared/errors.ts";
import { config } from "../shared/lib/config.ts";
import { createChildLogger } from "../shared/lib/logger.ts";

const log = createChildLogger("sandbox-destroyer");

interface SandboxDestroyerDependencies {
  sandboxService: SandboxService;
}

export class SandboxDestroyer {
  constructor(private readonly deps: SandboxDestroyerDependencies) {}

  async destroy(sandboxId: string): Promise<void> {
    const sandbox = this.deps.sandboxService.getById(sandboxId);
    if (!sandbox) {
      throw new NotFoundError("Sandbox", sandboxId);
    }

    log.info({ sandboxId }, "Destroying sandbox");

    if (!config.isMock()) {
      if (sandbox.runtime.pid) {
        await $`kill ${sandbox.runtime.pid} 2>/dev/null || true`
          .quiet()
          .nothrow();
        await Bun.sleep(500);
        await $`kill -9 ${sandbox.runtime.pid} 2>/dev/null || true`
          .quiet()
          .nothrow();
      }

      const socketPath = getSocketPath(sandboxId);
      const pidPath = `${config.paths.SOCKET_DIR}/${sandboxId}.pid`;
      await $`rm -f ${socketPath} ${pidPath}`.quiet().nothrow();

      const lvmAvailable = await StorageService.isAvailable();
      if (lvmAvailable) {
        await StorageService.deleteSandboxVolume(sandboxId);
      } else {
        const overlayPath = `${config.paths.OVERLAY_DIR}/${sandboxId}.ext4`;
        await $`rm -f ${overlayPath}`.quiet().nothrow();
      }

      const tapDevice = `tap-${sandboxId.slice(0, 8)}`;
      await NetworkService.deleteTap(tapDevice);

      NetworkService.release(sandbox.runtime.ipAddress);
      await CaddyService.removeRoutes(sandboxId);
    }

    this.deps.sandboxService.delete(sandboxId);
    log.info({ sandboxId }, "Sandbox destroyed");
  }
}
