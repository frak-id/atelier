import { DEFAULTS } from "@frak/atelier-shared/constants";
import type { CreateSandboxBody, Sandbox } from "../../schemas/index.ts";
import { createChildLogger } from "../../shared/lib/logger.ts";
import {
  type BootResult,
  bootNewSandbox,
  cleanupSandboxResources,
  finalizeNewSandbox,
  waitForOpencode,
} from "../kernel/index.ts";
import { GuestOps } from "../ports/guest-ops.ts";
import type { SandboxPorts } from "../ports/sandbox-ports.ts";

const log = createChildLogger("wf-create-system");

export async function createSystemSandbox(
  sandboxId: string,
  options: CreateSandboxBody,
  ports: SandboxPorts,
): Promise<Sandbox> {
  let boot: BootResult | undefined;

  try {
    boot = await bootNewSandbox(
      sandboxId,
      {
        workspaceId: options.workspaceId,
        system: true,
        baseImage: options.baseImage,
        vcpus: options.vcpus ?? DEFAULTS.VCPUS,
        memoryMb: options.memoryMb ?? DEFAULTS.MEMORY_MB,
        prebuildReady: options.prebuildSnapshotName != null,
        prebuildSnapshotName: options.prebuildSnapshotName,
      },
      ports,
    );

    await ports.cliproxy
      .createSandboxKey(sandboxId)
      .catch((err: unknown) =>
        log.warn({ err, sandboxId }, "Failed to create CLIProxy sandbox key"),
      );

    const [syncResult] = await Promise.all([
      ports.internal.syncAllToSandbox(sandboxId),
      ports.agent.writeFiles(sandboxId, [
        ...GuestOps.buildRuntimeEnvFiles({ ATELIER_SANDBOX_ID: sandboxId }),
      ]),
    ]);
    log.info(
      {
        sandboxId,
        authSynced: syncResult.auth.synced,
        configsSynced: syncResult.configs.synced,
        registry: syncResult.registry,
      },
      "Internal sync complete",
    );

    await GuestOps.startServices(ports.agent, sandboxId, ["opencode"]);

    await waitForOpencode(
      boot.sandbox.runtime.ipAddress,
      boot.sandbox.runtime.opencodePassword,
    );

    return await finalizeNewSandbox(
      sandboxId,
      boot.sandbox,
      boot.podName,
      ports,
      { system: true },
    );
  } catch (error) {
    log.error(
      {
        sandboxId,
        error: error instanceof Error ? error.message : error,
      },
      "Failed to create system sandbox",
    );
    if (boot) {
      await cleanupSandboxResources(sandboxId, {
        podName: boot.podName,
      });
    }
    try {
      ports.sandbox.updateStatus(sandboxId, "error", "Build failed");
    } catch {}
    throw error;
  }
}
