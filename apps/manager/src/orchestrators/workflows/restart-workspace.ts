import type { Sandbox, Workspace } from "../../schemas/index.ts";
import { createChildLogger } from "../../shared/lib/logger.ts";
import {
  bootExistingSandbox,
  finalizeRestartedSandbox,
} from "../kernel/index.ts";
import * as guestOps from "../ports/guest-ops.ts";
import type { SandboxPorts } from "../ports/sandbox-ports.ts";

const log = createChildLogger("wf-restart-workspace");

export async function restartWorkspaceSandbox(
  sandboxId: string,
  sandbox: Sandbox,
  workspace: Workspace,
  ports: SandboxPorts,
): Promise<Sandbox> {
  const boot = await bootExistingSandbox(sandboxId, sandbox, ports);

  if (boot.agentReady) {
    await guestOps.configureDns(ports.agent, sandboxId);
    await guestOps.syncClock(ports.agent, sandboxId);
    await guestOps.mountSharedBinaries(ports.agent, sandboxId);
    await guestOps.pushRuntimeEnv(ports.agent, sandboxId, {
      ATELIER_SANDBOX_ID: sandboxId,
    });
    await guestOps.setHostname(ports.agent, sandboxId, `sandbox-${sandboxId}`);

    await guestOps.syncSecrets(ports.agent, sandboxId, workspace);
    await guestOps.syncGitCredentials(ports.agent, sandboxId, ports.gitSources);
    await guestOps.syncFileSecrets(ports.agent, sandboxId, workspace);

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

    await guestOps.startServices(ports.agent, sandboxId, [
      "vscode",
      "opencode",
    ]);
  }

  return await finalizeRestartedSandbox(sandboxId, sandbox, boot.pid, ports);
}
