import { VM_PATHS } from "@frak/atelier-shared/constants";
import type { Workspace } from "../../schemas/index.ts";
import { createChildLogger } from "../../shared/lib/logger.ts";
import * as guestOps from "../ports/guest-ops.ts";
import type { SandboxPorts } from "../ports/sandbox-ports.ts";
import { buildSandboxConfig, generateSandboxMd } from "../sandbox-config.ts";

const log = createChildLogger("wf-create-workspace");

export async function provisionWorkspaceCreate(
  sandboxId: string,
  workspace: Workspace,
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
    workspace,
    opencodePassword,
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

  await guestOps.startServices(ports.agent, sandboxId, ["vscode", "opencode"]);
  await guestOps.setupSwap(ports.agent, sandboxId);

  if (!usedPrebuild && workspace.config.repos?.length) {
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
}
