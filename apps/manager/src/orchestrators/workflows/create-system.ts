import { DEFAULTS } from "@frak/atelier-shared/constants";
import type { CreateSandboxBody, Sandbox } from "../../schemas/index.ts";
import { createChildLogger } from "../../shared/lib/logger.ts";
import {
  type BootResult,
  bootNewSandbox,
  cleanupSandboxResources,
  finalizeNewSandbox,
} from "../kernel/index.ts";
import { GuestOps } from "../ports/guest-ops.ts";
import type { SandboxPorts } from "../ports/sandbox-ports.ts";
import { buildSandboxConfig } from "../sandbox-config.ts";

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
        prebuildReady: false,
      },
      ports,
    );
    // --- Guest provisioning (linear, no branching) ---
    await GuestOps.configureDns(ports.agent, sandboxId);
    await GuestOps.syncClock(ports.agent, sandboxId);

    if (!boot.usedPrebuild) {
      const resized = await GuestOps.resizeStorage(ports.agent, sandboxId);
      if (resized.success) {
        log.info(
          { sandboxId, disk: resized.disk },
          "Filesystem expanded successfully",
        );
      } else {
        log.warn(
          { sandboxId, error: resized.error },
          "Failed to expand filesystem inside VM",
        );
      }
    }

    const sandboxConfig = buildSandboxConfig(
      sandboxId,
      undefined,
      boot.sandbox.runtime.opencodePassword,
    );
    await GuestOps.pushSandboxConfig(ports.agent, sandboxId, sandboxConfig);
    await GuestOps.pushRuntimeEnv(ports.agent, sandboxId, {
      ATELIER_SANDBOX_ID: sandboxId,
    });
    await GuestOps.setHostname(ports.agent, sandboxId, `sandbox-${sandboxId}`);

    const result = await ports.internal.syncAllToSandbox(sandboxId);
    log.info(
      {
        sandboxId,
        authSynced: result.auth.synced,
        configsSynced: result.configs.synced,
        registry: result.registry,
      },
      "Internal sync complete",
    );

    await GuestOps.startServices(ports.agent, sandboxId, ["opencode"]);

    // --- Finalize: register routes + update status ---
    return await finalizeNewSandbox(
      sandboxId,
      boot.sandbox,
      boot.network,
      boot.pid,
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
        pid: boot.pid,
        paths: boot.paths,
        network: boot.network,
      });
    }
    try {
      ports.sandbox.updateStatus(sandboxId, "error", "Build failed");
    } catch {}
    throw error;
  }
}
