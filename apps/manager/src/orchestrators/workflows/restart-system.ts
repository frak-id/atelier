import { createChildLogger } from "../../shared/lib/logger.ts";
import * as guestOps from "../ports/guest-ops.ts";
import type { SandboxPorts } from "../ports/sandbox-ports.ts";

const log = createChildLogger("wf-restart-system");

export async function provisionSystemRestart(
  sandboxId: string,
  ports: SandboxPorts,
): Promise<void> {
  await guestOps.configureDns(ports.agent, sandboxId);
  await guestOps.syncClock(ports.agent, sandboxId);
  await guestOps.mountSharedBinaries(ports.agent, sandboxId);
  await guestOps.pushRuntimeEnv(ports.agent, sandboxId, {
    ATELIER_SANDBOX_ID: sandboxId,
  });
  await guestOps.setHostname(ports.agent, sandboxId, `sandbox-${sandboxId}`);

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

  await guestOps.startServices(ports.agent, sandboxId, ["opencode"]);
}
