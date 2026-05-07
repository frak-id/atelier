import type { Sandbox, Workspace } from "../../schemas/index.ts";
import { createChildLogger } from "../../shared/lib/logger.ts";
import {
  bootExistingSandbox,
  finalizeRestartedSandbox,
  waitForOpencodeHealthy,
} from "../kernel/index.ts";
import { GuestOps } from "../ports/guest-ops.ts";
import type { SandboxPorts } from "../ports/sandbox-ports.ts";
import { resolveWorkspaceDir } from "../sandbox-config.ts";

const log = createChildLogger("wf-restart-workspace");

export async function restartWorkspaceSandbox(
  sandboxId: string,
  sandbox: Sandbox,
  workspace: Workspace,
  ports: SandboxPorts,
  createdByUserId?: string,
): Promise<Sandbox> {
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

    // Re-mint the source-directory symlink — the sandbox's rootfs was
    // recreated by `bootExistingSandbox`, so any symlinks from the original
    // spawn are gone. Sourced from `opencodeWorkspaceContext`, which is
    // persisted on the Sandbox row exactly so restarts don't need the
    // local CLI to re-supply this.
    const sourceLocalDirectory =
      sandbox.opencodeWorkspaceContext?.sourceLocalDirectory;
    if (sourceLocalDirectory) {
      await GuestOps.mintSourceDirectorySymlink(
        ports.agent,
        sandboxId,
        sourceLocalDirectory,
        resolveWorkspaceDir(workspace),
      );
    }

    await GuestOps.startServices(ports.agent, sandboxId, [
      "vscode",
      "opencode",
    ]);

    await waitForOpencodeHealthy(
      sandbox.runtime.ipAddress,
      sandbox.runtime.opencodePassword,
    );
  }

  return await finalizeRestartedSandbox(
    sandboxId,
    sandbox,
    boot.podName,
    ports,
  );
}
