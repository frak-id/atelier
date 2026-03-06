import { DEFAULTS, VM_PATHS } from "@frak/atelier-shared/constants";
import type {
  CreateSandboxBody,
  Sandbox,
  Workspace,
} from "../../schemas/index.ts";
import { createChildLogger } from "../../shared/lib/logger.ts";
import {
  type BootResult,
  bootNewSandbox,
  cleanupSandboxResources,
  finalizeNewSandbox,
} from "../kernel/index.ts";
import { GuestOps } from "../ports/guest-ops.ts";
import type { GitUserIdentity } from "../ports/guest-secrets.ts";
import type { SandboxPorts } from "../ports/sandbox-ports.ts";
import { generateSandboxMd } from "../sandbox-config.ts";

const log = createChildLogger("wf-create-workspace");

export async function createWorkspaceSandbox(
  sandboxId: string,
  workspace: Workspace,
  options: CreateSandboxBody,
  ports: SandboxPorts,
  gitUserIdentity?: GitUserIdentity,
): Promise<Sandbox> {
  let boot: BootResult | undefined;

  try {
    const prebuildReady = workspace.config.prebuild?.status === "ready";
    boot = await bootNewSandbox(
      sandboxId,
      {
        workspaceId: workspace.id,
        workspace,
        baseImage: options.baseImage ?? workspace.config.baseImage,
        vcpus: options.vcpus ?? workspace.config.vcpus ?? DEFAULTS.VCPUS,
        memoryMb:
          options.memoryMb ?? workspace.config.memoryMb ?? DEFAULTS.MEMORY_MB,
        prebuildReady,
        prebuildSnapshotName: prebuildReady
          ? workspace.config.prebuild?.latestId
          : undefined,
      },
      ports,
    );

    const configs = ports.configFiles.getMergedForSandbox(workspace.id);
    const authConfig = configs.find((c) => c.path === VM_PATHS.opencodeAuth);
    let providers: string[] = [];
    if (authConfig) {
      try {
        const authJson = JSON.parse(authConfig.content) as Record<
          string,
          unknown
        >;
        providers = Object.keys(authJson);
      } catch {
        log.warn("Failed to parse auth.json for oh-my-opencode cache seed");
      }
    }
    const mdContent = generateSandboxMd(sandboxId, workspace);

    await ports.cliproxy
      .createSandboxKey(sandboxId)
      .catch((err: unknown) =>
        log.warn({ err, sandboxId }, "Failed to create CLIProxy sandbox key"),
      );

    const [secretFiles, gitCredFiles, fileSecretFiles] = await Promise.all([
      GuestOps.collectSecretFiles(workspace),
      GuestOps.collectGitCredentialFiles(ports.gitSources, gitUserIdentity),
      GuestOps.collectFileSecretFiles(workspace),
    ]);

    const [syncResult] = await Promise.all([
      ports.internal.syncAllToSandbox(sandboxId),
      ports.agent.writeFiles(sandboxId, [
        ...GuestOps.buildRuntimeEnvFiles({ ATELIER_SANDBOX_ID: sandboxId }),
        ...GuestOps.buildOhMyOpenCodeCacheFiles(providers),
        ...GuestOps.buildSandboxMdFile(mdContent),
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

    if (!boot.usedPrebuild && workspace.config.repos?.length) {
      for (const repo of workspace.config.repos) {
        await GuestOps.cloneRepository(
          ports.agent,
          sandboxId,
          repo,
          ports.gitSources,
        );
      }
      await GuestOps.sanitizeGitRemoteUrls(
        ports.agent,
        sandboxId,
        workspace.config.repos,
      );
    }

    await GuestOps.startServices(ports.agent, sandboxId, [
      "vscode",
      "opencode",
    ]);

    return await finalizeNewSandbox(
      sandboxId,
      boot.sandbox,
      boot.podName,
      ports,
      { system: false },
    );
  } catch (error) {
    log.error(
      {
        sandboxId,
        error: error instanceof Error ? error.message : error,
      },
      "Failed to create workspace sandbox",
    );
    if (boot) {
      await cleanupSandboxResources(sandboxId, {
        podName: boot.podName,
      });
    }
    try {
      ports.sandbox.updateStatus(sandboxId, "error", "Build failed");
    } catch {}
    throw error;
  }
}
