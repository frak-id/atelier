import { DEFAULTS } from "@frak/atelier-shared/constants";
import type {
  CreateSandboxBody,
  Sandbox,
  Workspace,
} from "../../schemas/index.ts";
import { createChildLogger } from "../../shared/lib/logger.ts";
import { PhaseTimer } from "../../shared/lib/phase-timer.ts";
import {
  type BootResult,
  bootNewSandbox,
  cleanupSandboxResources,
  finalizeNewSandbox,
  waitForOpencodeHealthy,
} from "../kernel/index.ts";
import { GuestOps } from "../ports/guest-ops.ts";
import type { GitUserIdentity } from "../ports/guest-secrets.ts";
import type { SandboxPorts } from "../ports/sandbox-ports.ts";
import { generateSandboxMd } from "../sandbox-config.ts";
import { bootServiceNames } from "../tools/registry.ts";

const log = createChildLogger("wf-create-workspace");

export async function createWorkspaceSandbox(
  sandboxId: string,
  workspace: Workspace,
  options: CreateSandboxBody,
  ports: SandboxPorts,
  createdByUserId?: string,
): Promise<Sandbox> {
  let boot: BootResult | undefined;
  const timer = new PhaseTimer(log, { metric: "sandbox_boot", sandboxId });

  try {
    // The CLIProxy key value is derived deterministically, so the config sync
    // below can bake it without waiting on registration. Fire registration now
    // so it overlaps VM boot, and await it once before marking the sandbox ready.
    const cliproxyKeyReg = ports.cliproxy
      .ensureSandboxKey(sandboxId)
      .catch((err: unknown) =>
        log.warn({ err, sandboxId }, "Failed to register CLIProxy sandbox key"),
      );

    const prebuildReady = workspace.config.prebuild?.status === "ready";
    boot = await timer.step("kube_boot", () =>
      bootNewSandbox(
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
          name: options.name,
          origin: options.origin,
          createdBy: createdByUserId,
          // Forward workspace-mode env from the opencode-atelier plugin so
          // the remote `opencode serve` boots in workspace mode.
          opencodeWorkspaceContext: {
            opencodeEnv: options.opencodeEnv,
            sourceWorkspaceFromID: options.sourceWorkspaceFromID,
          },
        },
        ports,
      ),
    );
    const bootResult = boot;

    const mdContent = generateSandboxMd(sandboxId, workspace);

    const creator = createdByUserId
      ? ports.users.getById(createdByUserId)
      : undefined;
    const gitUserIdentity: GitUserIdentity | undefined = creator
      ? { name: creator.username, email: creator.email }
      : undefined;
    const githubToken = ports.users.resolveGitHubToken(createdByUserId);

    const [secretFiles, gitCredFiles, fileSecretFiles] = await timer.step(
      "collect_secrets",
      () =>
        Promise.all([
          GuestOps.collectSecretFiles(workspace),
          GuestOps.collectGitCredentialFiles(githubToken, gitUserIdentity),
          GuestOps.collectFileSecretFiles(workspace),
        ]),
    );

    const [syncResult] = await timer.step("internal_sync", () =>
      Promise.all([
        ports.internal.syncAllToSandbox(sandboxId),
        ports.agent.writeFiles(sandboxId, [
          ...GuestOps.buildRuntimeEnvFiles({ ATELIER_SANDBOX_ID: sandboxId }),
          ...GuestOps.buildSandboxMdFile(mdContent),
          ...secretFiles,
          ...gitCredFiles,
          ...fileSecretFiles,
        ]),
      ]),
    );
    log.info(
      {
        sandboxId,
        authSynced: syncResult.auth.synced,
        configsSynced: syncResult.configs.synced,
        registry: syncResult.registry,
      },
      "Internal sync complete",
    );

    if (!bootResult.usedPrebuild && workspace.config.repos?.length) {
      // For single-repo workspaces, allow `options.branch` to override the
      // workspace's default branch. Multi-repo workspaces always use the
      // configured per-repo branch — overriding one would be ambiguous.
      const repos =
        options.branch && workspace.config.repos.length === 1
          ? workspace.config.repos.map((r) => ({
              ...r,
              branch: options.branch as string,
            }))
          : workspace.config.repos;

      await timer.step("clone_repos", async () => {
        for (const repo of repos) {
          await GuestOps.cloneRepository(
            ports.agent,
            sandboxId,
            repo,
            githubToken,
          );
        }
        await GuestOps.sanitizeGitRemoteUrls(
          ports.agent,
          sandboxId,
          workspace.config.repos,
        );
      });
    }

    await timer.step("start_services", () =>
      GuestOps.startServices(ports.agent, sandboxId, bootServiceNames()),
    );

    // Wait for OpenCode to be fully ready (HTTP healthy + agent registry loaded)
    // before finalizing. Otherwise callers receive a `running` sandbox that
    // would silently drop the first prompt.
    // Only wait for OpenCode HTTP to be healthy here. The agent registry
    // wait (needed before issuing prompts) is handled inside
    // `openOpencodeSession`, paid lazily by the first session creator.
    await timer.step("opencode_healthy", () =>
      waitForOpencodeHealthy(
        bootResult.sandbox.runtime.ipAddress,
        bootResult.sandbox.runtime.opencodePassword,
      ),
    );

    await cliproxyKeyReg;

    const sandbox = await timer.step("finalize", () =>
      finalizeNewSandbox(
        sandboxId,
        bootResult.sandbox,
        bootResult.podName,
        ports,
      ),
    );
    timer.end({ fromPrebuild: bootResult.usedPrebuild });
    return sandbox;
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
