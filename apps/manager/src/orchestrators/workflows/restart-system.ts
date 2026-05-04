import type { Sandbox } from "../../schemas/index.ts";
import { createChildLogger } from "../../shared/lib/logger.ts";
import {
  bootExistingSandbox,
  finalizeRestartedSandbox,
  waitForOpencode,
} from "../kernel/index.ts";
import { GuestOps } from "../ports/guest-ops.ts";
import type { SandboxPorts } from "../ports/sandbox-ports.ts";

const log = createChildLogger("wf-restart-system");

export async function restartSystemSandbox(
  sandboxId: string,
  sandbox: Sandbox,
  ports: SandboxPorts,
): Promise<Sandbox> {
  const boot = await bootExistingSandbox(sandboxId, sandbox, ports);

  if (boot.agentReady) {
    // --- Parallel batch: writeFiles + internal sync ---
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
      sandbox.runtime.ipAddress,
      sandbox.runtime.opencodePassword,
    );
  }

  return await finalizeRestartedSandbox(
    sandboxId,
    sandbox,
    boot.podName,
    ports,
    {
      system: true,
    },
  );
}
