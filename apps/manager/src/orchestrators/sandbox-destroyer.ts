import { eventBus } from "../infrastructure/events/index.ts";
import type { SandboxRepository } from "../modules/sandbox/index.ts";
import { NotFoundError } from "../shared/errors.ts";
import { isMock } from "../shared/lib/config.ts";
import { createChildLogger } from "../shared/lib/logger.ts";
import { cleanupSandboxResources } from "./kernel/index.ts";

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
      await cleanupSandboxResources(sandboxId, {
        podName: `sandbox-${sandboxId}`,
      });
    }

    this.deps.sandboxService.delete(sandboxId);
    eventBus.emit({
      type: "sandbox.deleted",
      properties: { id: sandboxId, workspaceId: sandbox.workspaceId },
    });
    log.info({ sandboxId }, "Sandbox destroyed");
  }
}
