import { PATHS } from "@frak/atelier-shared/constants";
import { $ } from "bun";
import { eventBus } from "../infrastructure/events/index.ts";
import { NetworkService } from "../infrastructure/network/index.ts";
import {
  CaddyService,
  SshPiperService,
} from "../infrastructure/proxy/index.ts";
import { StorageService } from "../infrastructure/storage/index.ts";
import type { SandboxRepository } from "../modules/sandbox/index.ts";
import { NotFoundError } from "../shared/errors.ts";
import { isMock } from "../shared/lib/config.ts";
import { createChildLogger } from "../shared/lib/logger.ts";
import { cleanupSandboxFiles, killProcess } from "../shared/lib/shell.ts";

const log = createChildLogger("sandbox-destroyer");

interface SandboxDestroyerDependencies {
  sandboxService: SandboxRepository;
}

export class SandboxDestroyer {
  constructor(private readonly deps: SandboxDestroyerDependencies) {}

  async destroy(sandboxId: string): Promise<void> {
    const sandbox = this.deps.sandboxService.getById(sandboxId);
    if (!sandbox) {
      throw new NotFoundError("Sandbox", sandboxId);
    }

    log.info({ sandboxId }, "Destroying sandbox");

    if (!isMock()) {
      if (sandbox.runtime.pid) {
        await killProcess(sandbox.runtime.pid);
      }

      await cleanupSandboxFiles(sandboxId);

      const lvmAvailable = await StorageService.isAvailable();
      if (lvmAvailable) {
        await StorageService.deleteSandboxVolume(sandboxId);
      } else {
        const overlayPath = `${PATHS.OVERLAY_DIR}/${sandboxId}.ext4`;
        await $`rm -f ${overlayPath}`.quiet().nothrow();
      }

      const tapDevice = `tap-${sandboxId.slice(0, 8)}`;
      await NetworkService.deleteTap(tapDevice);

      NetworkService.release(sandbox.runtime.ipAddress);
      await CaddyService.removeRoutes(sandboxId);
      await SshPiperService.removeRoute(sandboxId);
    }

    this.deps.sandboxService.delete(sandboxId);
    eventBus.emit({
      type: "sandbox.deleted",
      properties: { id: sandboxId, workspaceId: sandbox.workspaceId },
    });
    log.info({ sandboxId }, "Sandbox destroyed");
  }
}
