import { createChildLogger } from "../../shared/lib/logger.ts";
import * as guestOps from "../ports/guest-ops.ts";
import type { SandboxPorts } from "../ports/sandbox-ports.ts";
import { buildSandboxConfig } from "../sandbox-config.ts";

const log = createChildLogger("wf-create-system");

export async function provisionSystemCreate(
  sandboxId: string,
  usedPrebuild: boolean,
  opencodePassword: string | undefined,
  ports: SandboxPorts,
): Promise<void> {
  await guestOps.configureDns(ports.agent, sandboxId);
  await guestOps.syncClock(ports.agent, sandboxId);

  if (!usedPrebuild) {
    const resized = await guestOps.resizeStorage(ports.agent, sandboxId);
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
    opencodePassword,
  );
  await guestOps.pushSandboxConfig(ports.agent, sandboxId, sandboxConfig);
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
