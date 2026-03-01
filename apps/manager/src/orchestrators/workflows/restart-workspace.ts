import type { Sandbox, Workspace } from "../../schemas/index.ts";
import { createChildLogger } from "../../shared/lib/logger.ts";
import {
  bootExistingSandbox,
  finalizeRestartedSandbox,
} from "../kernel/index.ts";
import { GuestOps } from "../ports/guest-ops.ts";
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
    // --- Batch: DNS + clock + mount in one call ---
    const mountCmd = await GuestOps.buildMountSharedBinariesCommand();
    await ports.agent.batchExec(sandboxId, [
      GuestOps.buildDnsCommand(),
      GuestOps.buildClockSyncCommand(),
      ...(mountCmd ? [mountCmd] : []),
    ]);

    // --- Collect files (parallel async prep) ---
    const [secretFiles, gitCredFiles, fileSecretFiles] = await Promise.all([
      GuestOps.collectSecretFiles(workspace),
      GuestOps.collectGitCredentialFiles(ports.gitSources),
      GuestOps.collectFileSecretFiles(workspace),
    ]);

    // --- Parallel batch: writeFiles + hostname + internal sync ---
    const [syncResult] = await Promise.all([
      ports.internal.syncAllToSandbox(sandboxId),
      ports.agent.writeFiles(sandboxId, [
        ...GuestOps.buildRuntimeEnvFiles({ ATELIER_SANDBOX_ID: sandboxId }),
        ...secretFiles,
        ...gitCredFiles,
        ...fileSecretFiles,
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

    await GuestOps.startServices(ports.agent, sandboxId, [
      "vscode",
      "opencode",
    ]);
  }

  return await finalizeRestartedSandbox(sandboxId, sandbox, boot.pid, ports, {
    system: false,
  });
}
