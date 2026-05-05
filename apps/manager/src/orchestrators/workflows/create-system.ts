import { DEFAULTS } from "@frak/atelier-shared/constants";
import type { CreateSandboxBody, Sandbox } from "../../schemas/index.ts";
import { createChildLogger } from "../../shared/lib/logger.ts";
import {
  type BootResult,
  bootNewSandbox,
  cleanupSandboxResources,
  finalizeNewSandbox,
  waitForOpencodeHealthy,
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
        baseImage: options.baseImage,
        vcpus: options.vcpus ?? DEFAULTS.VCPUS,
        memoryMb: options.memoryMb ?? DEFAULTS.MEMORY_MB,
        prebuildReady: options.prebuildSnapshotName != null,
        prebuildSnapshotName: options.prebuildSnapshotName,
        // Forward the system origin so the persisted sandbox row carries
        // `origin.source: "system"` (used by all the system-vs-user filters).
        origin: options.origin,
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

    // Only wait for OpenCode HTTP healthy. The system sandbox itself ensures
    // full readiness on `acquire()` before handing the client to the AI
    // service, so we don't need the heavier check here.
    await waitForOpencodeHealthy(
      boot.sandbox.runtime.ipAddress,
      boot.sandbox.runtime.opencodePassword,
    );

    return await finalizeNewSandbox(
      sandboxId,
      boot.sandbox,
      boot.podName,
      ports,
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
