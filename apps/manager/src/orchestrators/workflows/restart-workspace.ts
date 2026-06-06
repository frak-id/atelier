import type { Sandbox, Workspace } from "../../schemas/index.ts";
import { createChildLogger } from "../../shared/lib/logger.ts";
import {
  bootExistingSandbox,
  finalizeRestartedSandbox,
  waitForOpencodeHealthy,
} from "../kernel/index.ts";
import { GuestOps } from "../ports/guest-ops.ts";
import type { SandboxPorts } from "../ports/sandbox-ports.ts";
import { bootServiceNames } from "../tools/registry.ts";

const log = createChildLogger("wf-restart-workspace");

export async function restartWorkspaceSandbox(
  sandboxId: string,
  sandbox: Sandbox,
  workspace: Workspace,
  ports: SandboxPorts,
  createdByUserId?: string,
): Promise<Sandbox> {
  // Re-register the derived CLIProxy key (idempotent) so a CLIProxy that lost
  // its key store recovers on restart; overlaps boot, awaited before finalize.
  const cliproxyKeyReg = ports.cliproxy
    .ensureSandboxKey(sandboxId)
    .catch((err: unknown) =>
      log.warn({ err, sandboxId }, "Failed to register CLIProxy sandbox key"),
    );

  const boot = await bootExistingSandbox(sandboxId, sandbox, ports);
  const githubToken = ports.users.resolveGitHubToken(createdByUserId);

  if (boot.agentReady) {
    // --- Collect files (parallel async prep) ---
    const [secretFiles, gitCredFiles, fileSecretFiles] = await Promise.all([
      GuestOps.collectSecretFiles(workspace),
      GuestOps.collectGitCredentialFiles(githubToken),
      GuestOps.collectFileSecretFiles(workspace),
    ]);

    // --- Parallel batch: writeFiles + internal sync ---
    const [syncResult] = await Promise.all([
      ports.internal.syncAllToSandbox(sandboxId),
      ports.agent.writeFiles(sandboxId, [
        ...GuestOps.buildRuntimeEnvFiles({ ATELIER_SANDBOX_ID: sandboxId }),
        ...secretFiles,
        ...gitCredFiles,
        ...fileSecretFiles,
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

    await GuestOps.startServices(ports.agent, sandboxId, bootServiceNames());

    await waitForOpencodeHealthy(
      sandbox.runtime.ipAddress,
      sandbox.runtime.opencodePassword,
    );
  }

  await cliproxyKeyReg;

  return await finalizeRestartedSandbox(
    sandboxId,
    sandbox,
    boot.podName,
    ports,
  );
}
