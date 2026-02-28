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
import type { SandboxPorts } from "../ports/sandbox-ports.ts";
import { buildSandboxConfig, generateSandboxMd } from "../sandbox-config.ts";

const log = createChildLogger("wf-create-workspace");

export async function createWorkspaceSandbox(
  sandboxId: string,
  workspace: Workspace,
  options: CreateSandboxBody,
  ports: SandboxPorts,
): Promise<Sandbox> {
  let boot: BootResult | undefined;

  try {
    boot = await bootNewSandbox(
      sandboxId,
      {
        workspaceId: workspace.id,
        baseImage: options.baseImage ?? workspace.config.baseImage,
        vcpus: options.vcpus ?? workspace.config.vcpus ?? DEFAULTS.VCPUS,
        memoryMb:
          options.memoryMb ?? workspace.config.memoryMb ?? DEFAULTS.MEMORY_MB,
        prebuildReady: workspace.config.prebuild?.status === "ready",
      },
      ports,
    );
    // --- Guest provisioning (linear, no branching) ---
    await GuestOps.configureDns(ports.agent, sandboxId);
    await GuestOps.syncClock(ports.agent, sandboxId);

    if (!boot.usedPrebuild) {
      const resized = await GuestOps.resizeStorage(ports.agent, sandboxId);
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
      workspace,
      boot.sandbox.runtime.opencodePassword,
    );
    await GuestOps.pushSandboxConfig(ports.agent, sandboxId, sandboxConfig);
    await GuestOps.pushRuntimeEnv(ports.agent, sandboxId, {
      ATELIER_SANDBOX_ID: sandboxId,
    });
    await GuestOps.setHostname(ports.agent, sandboxId, `sandbox-${sandboxId}`);

    await GuestOps.syncSecrets(ports.agent, sandboxId, workspace);
    await GuestOps.syncGitCredentials(ports.agent, sandboxId, ports.gitSources);
    await GuestOps.syncFileSecrets(ports.agent, sandboxId, workspace);

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
    await GuestOps.pushOhMyOpenCodeCache(ports.agent, sandboxId, providers);

    const mdContent = generateSandboxMd(sandboxId, workspace);
    await GuestOps.pushSandboxMd(ports.agent, sandboxId, mdContent);

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

    await GuestOps.startServices(ports.agent, sandboxId, [
      "vscode",
      "opencode",
    ]);
    await GuestOps.setupSwap(ports.agent, sandboxId);

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

    // --- Finalize: register routes + update status ---
    return await finalizeNewSandbox(
      sandboxId,
      boot.sandbox,
      boot.network,
      boot.pid,
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
    // Only cleanup if boot completed (boot handles its own rollback)
    if (boot) {
      await cleanupSandboxResources(sandboxId, {
        pid: boot.pid,
        paths: boot.paths,
        network: boot.network,
      });
    }
    try {
      ports.sandbox.updateStatus(sandboxId, "error", "Build failed");
    } catch {}
    throw error;
  }
}
