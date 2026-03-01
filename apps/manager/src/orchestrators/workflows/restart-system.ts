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
    // --- Batch: DNS + clock + mount in one call ---
    const mountCmd = await GuestOps.buildMountSharedBinariesCommand();
    await ports.agent.batchExec(sandboxId, [
      GuestOps.buildDnsCommand(),
      GuestOps.buildClockSyncCommand(),
      ...(mountCmd ? [mountCmd] : []),
    ]);

    // --- Parallel batch: writeFiles + hostname + internal sync ---
    const [syncResult] = await Promise.all([
      ports.internal.syncAllToSandbox(sandboxId),
      ports.agent.writeFiles(sandboxId, [
        ...GuestOps.buildRuntimeEnvFiles({ ATELIER_SANDBOX_ID: sandboxId }),
      ]),
      ports.agent.batchExec(sandboxId, [
        GuestOps.buildHostnameCommand(`sandbox-${sandboxId}`),
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
  }

  return await finalizeRestartedSandbox(sandboxId, sandbox, boot.pid, ports, {
    system: true,
  });
}
