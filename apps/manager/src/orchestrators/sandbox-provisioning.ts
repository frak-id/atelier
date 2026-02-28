import { VM_PATHS } from "@frak/atelier-shared/constants";
import { createOpencodeClient } from "@opencode-ai/sdk/v2";
import type {
  AgentClient,
  AgentOperations,
} from "../infrastructure/agent/index.ts";
import { SecretsService } from "../infrastructure/secrets/index.ts";
import { SharedStorageService } from "../infrastructure/storage/index.ts";
import type { ConfigFileService } from "../modules/config-file/index.ts";
import type { GitSourceService } from "../modules/git-source/index.ts";
import type { InternalService } from "../modules/internal/index.ts";
import type { SandboxProvisionService } from "../modules/sandbox/index.ts";
import type { WorkspaceService } from "../modules/workspace/index.ts";
import type { Workspace } from "../schemas/index.ts";
import { config } from "../shared/lib/config.ts";
import { createChildLogger } from "../shared/lib/logger.ts";
import { buildOpenCodeAuthHeaders } from "../shared/lib/opencode-auth.ts";
import { buildSandboxConfig, generateSandboxMd } from "./sandbox-config.ts";
import type { SandboxProfile } from "./sandbox-profile.ts";

const log = createChildLogger("sandbox-provisioning");

const OPENCODE_HEALTH_TIMEOUT_MS = 120000;

export type ProvisionPhase = "create" | "restart";

export interface ProvisionDeps {
  provisionService: SandboxProvisionService;
  agentClient: AgentClient;
  agentOperations?: AgentOperations;
  internalService: InternalService;
  workspaceService: WorkspaceService;
  gitSourceService: GitSourceService;
  configFileService: ConfigFileService;
}

export async function syncSecrets(
  sandboxId: string,
  workspace: Workspace | undefined,
  provisionService: SandboxProvisionService,
): Promise<void> {
  const secrets = workspace?.config.secrets;
  if (!secrets || Object.keys(secrets).length === 0) return;

  const decrypted = await SecretsService.decryptSecrets(secrets);
  const envFile = SecretsService.generateEnvFile(decrypted);
  await provisionService.pushSecrets(sandboxId, envFile);
}

export async function syncGitCredentials(
  sandboxId: string,
  gitSourceService: GitSourceService,
  provisionService: SandboxProvisionService,
): Promise<void> {
  const sources = gitSourceService.getAll();
  const credentials: string[] = [];

  for (const source of sources) {
    if (source.type !== "github") continue;
    const accessToken = (source.config as { accessToken?: string }).accessToken;
    if (!accessToken) continue;
    credentials.push(`https://x-access-token:${accessToken}@github.com`);
  }

  await provisionService.pushGitConfig(sandboxId, credentials);
}

export async function syncFileSecrets(
  sandboxId: string,
  workspace: Workspace | undefined,
  provisionService: SandboxProvisionService,
): Promise<void> {
  const fileSecrets = workspace?.config.fileSecrets;
  if (!fileSecrets || fileSecrets.length === 0) return;

  const decrypted = await SecretsService.decryptFileSecrets(fileSecrets);
  await provisionService.pushFileSecrets(
    sandboxId,
    decrypted.map((s) => ({
      path: s.path,
      content: s.content,
      mode: s.mode,
    })),
  );
}

export async function buildAuthenticatedGitUrl(
  repo: { sourceId: string; repo: string },
  gitSourceService: GitSourceService,
): Promise<string> {
  const source = gitSourceService.getById(repo.sourceId);
  if (!source) {
    log.warn({ sourceId: repo.sourceId }, "Git source not found");
    return `https://github.com/${repo.repo}.git`;
  }

  if (source.type === "github") {
    const accessToken = (source.config as { accessToken?: string }).accessToken;
    if (accessToken) {
      return `https://x-access-token:${accessToken}@github.com/${repo.repo}.git`;
    }
  }

  return `https://github.com/${repo.repo}.git`;
}

export async function waitForOpencode(
  ipAddress: string,
  password?: string,
  timeout = OPENCODE_HEALTH_TIMEOUT_MS,
): Promise<void> {
  const startTime = Date.now();
  const url = `http://${ipAddress}:${config.advanced.vm.opencode.port}`;
  let delay = 250;

  while (Date.now() - startTime < timeout) {
    try {
      const client = createOpencodeClient({
        baseUrl: url,
        headers: buildOpenCodeAuthHeaders(password),
      });
      const { data } = await client.global.health();
      if (data?.healthy) {
        return;
      }
    } catch {}

    await Bun.sleep(delay);
    delay = Math.min(delay * 2, 2000);
  }

  throw new Error("OpenCode server did not become healthy within timeout");
}

export async function provisionGuest(
  sandboxId: string,
  profile: SandboxProfile,
  phase: ProvisionPhase,
  deps: ProvisionDeps,
  opencodePassword?: string,
): Promise<void> {
  await deps.provisionService.configureDns(sandboxId);
  await deps.provisionService.syncClock(sandboxId);

  if (phase === "create" && profile.expandFilesystem) {
    if (!deps.agentOperations) {
      throw new Error("agentOperations is required for create provisioning");
    }

    try {
      const agentResult = await deps.agentOperations.resizeStorage(sandboxId);
      if (agentResult.success) {
        log.info(
          { sandboxId, disk: agentResult.disk },
          "Filesystem expanded successfully",
        );
      } else {
        log.warn(
          { sandboxId, error: agentResult.error },
          "Failed to expand filesystem inside VM",
        );
      }
    } catch (error) {
      log.warn({ sandboxId, error }, "Filesystem expansion failed");
    }
  }

  if (phase === "create") {
    const sandboxConfig = buildSandboxConfig(
      sandboxId,
      profile.workspace,
      opencodePassword,
    );
    await deps.provisionService.pushSandboxConfig(sandboxId, sandboxConfig);
  }

  await deps.provisionService.pushRuntimeEnv(sandboxId, {
    ATELIER_SANDBOX_ID: sandboxId,
  });
  await deps.provisionService.setHostname(sandboxId, `sandbox-${sandboxId}`);

  if (phase === "restart") {
    const imageInfo = await SharedStorageService.getBinariesImageInfo();
    if (imageInfo.exists) {
      const mountResult = await deps.agentClient.exec(
        sandboxId,
        "mountpoint -q /opt/shared || { mknod -m 444 /dev/vdb b 254 16 2>/dev/null; mkdir -p /opt/shared && mount -o ro /dev/vdb /opt/shared; }",
        { timeout: 5000 },
      );
      if (mountResult.exitCode === 0) {
        log.info({ sandboxId }, "Shared binaries mounted");
      } else {
        log.warn(
          { sandboxId, stderr: mountResult.stderr },
          "Failed to mount shared binaries",
        );
      }
    }
  }

  if (profile.pushSecrets) {
    await syncSecrets(sandboxId, profile.workspace, deps.provisionService);
  }

  if (profile.pushGitCredentials) {
    await syncGitCredentials(
      sandboxId,
      deps.gitSourceService,
      deps.provisionService,
    );
  }

  if (profile.pushFileSecrets) {
    await syncFileSecrets(sandboxId, profile.workspace, deps.provisionService);
  }

  if (phase === "create" && profile.pushOhMyOpenCodeCache) {
    const configs = deps.configFileService.getMergedForSandbox(
      profile.workspace?.id,
    );
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

    await deps.provisionService.pushOhMyOpenCodeCache(sandboxId, providers);
  }

  if (phase === "create" && profile.pushSandboxMd) {
    const content = generateSandboxMd(sandboxId, profile.workspace);
    await deps.provisionService.pushSandboxMd(sandboxId, content);
  }

  const result = await deps.internalService.syncAllToSandbox(sandboxId);
  log.info(
    {
      sandboxId,
      authSynced: result.auth.synced,
      configsSynced: result.configs.synced,
      registry: result.registry,
    },
    "Auth, configs, and registry pushed to sandbox",
  );

  await deps.provisionService.startServices(sandboxId, profile.services);
}
