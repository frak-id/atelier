import { DEFAULTS, VM_PATHS } from "@frak/atelier-shared/constants";
import type {
  CreateSandboxBody,
  Sandbox,
  Workspace,
} from "../../schemas/index.ts";
import { createChildLogger } from "../../shared/lib/logger.ts";
import {
  bootNewSandbox,
  cleanupSandboxResources,
  finalizeNewSandbox,
} from "../kernel/index.ts";
import * as guestOps from "../ports/guest-ops.ts";
import type { SandboxPorts } from "../ports/sandbox-ports.ts";
import { buildSandboxConfig, generateSandboxMd } from "../sandbox-config.ts";

const log = createChildLogger("wf-create-workspace");

export async function createWorkspaceSandbox(
  sandboxId: string,
  workspace: Workspace,
  options: CreateSandboxBody,
  ports: SandboxPorts,
): Promise<Sandbox> {
  const boot = await bootNewSandbox(
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

  try {
    // --- Guest provisioning (linear, no branching) ---
    await guestOps.configureDns(ports.agent, sandboxId);
    await guestOps.syncClock(ports.agent, sandboxId);

    if (!boot.usedPrebuild) {
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
      workspace,
      boot.sandbox.runtime.opencodePassword,
    );
    await guestOps.pushSandboxConfig(ports.agent, sandboxId, sandboxConfig);
    await guestOps.pushRuntimeEnv(ports.agent, sandboxId, {
      ATELIER_SANDBOX_ID: sandboxId,
    });
    await guestOps.setHostname(ports.agent, sandboxId, `sandbox-${sandboxId}`);

    await guestOps.syncSecrets(ports.agent, sandboxId, workspace);
    await guestOps.syncGitCredentials(ports.agent, sandboxId, ports.gitSources);
    await guestOps.syncFileSecrets(ports.agent, sandboxId, workspace);

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
    await guestOps.pushOhMyOpenCodeCache(ports.agent, sandboxId, providers);

    const mdContent = generateSandboxMd(sandboxId, workspace);
    await guestOps.pushSandboxMd(ports.agent, sandboxId, mdContent);

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
    await guestOps.setupSwap(ports.agent, sandboxId);

    if (!boot.usedPrebuild && workspace.config.repos?.length) {
      for (const repo of workspace.config.repos) {
        await guestOps.cloneRepository(
          ports.agent,
          sandboxId,
          repo,
          ports.gitSources,
        );
      }
      await guestOps.sanitizeGitRemoteUrls(
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
    await cleanupSandboxResources(sandboxId, {
      pid: boot.pid,
      paths: boot.paths,
      network: boot.network,
    });
    try {
      ports.sandbox.updateStatus(sandboxId, "error", "Build failed");
    } catch {}
    throw error;
  }
}
