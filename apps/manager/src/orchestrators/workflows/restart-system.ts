import type { Sandbox } from "../../schemas/index.ts";
import { createChildLogger } from "../../shared/lib/logger.ts";
import {
  bootExistingSandbox,
  finalizeRestartedSandbox,
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
    await GuestOps.configureDns(ports.agent, sandboxId);
    await GuestOps.syncClock(ports.agent, sandboxId);
    await GuestOps.mountSharedBinaries(ports.agent, sandboxId);
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
  }

  return await finalizeRestartedSandbox(sandboxId, sandbox, boot.pid, ports, {
    system: true,
  });
}
