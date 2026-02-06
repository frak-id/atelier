import type { SandboxConfig } from "@frak/atelier-shared";
import { DEFAULTS, VM, VM_PATHS } from "@frak/atelier-shared/constants";
import { $ } from "bun";
import type {
  AgentClient,
  AgentOperations,
} from "../infrastructure/agent/index.ts";
import { eventBus } from "../infrastructure/events/index.ts";
import {
  configureVm,
  type FirecrackerClient,
  getPrebuildSnapshotPaths,
  getSandboxPaths,
  launchFirecracker,
  type SandboxPaths,
} from "../infrastructure/firecracker/index.ts";
import {
  type NetworkAllocation,
  NetworkService,
} from "../infrastructure/network/index.ts";
import {
  CaddyService,
  SshPiperService,
} from "../infrastructure/proxy/index.ts";
import { SecretsService } from "../infrastructure/secrets/index.ts";
import {
  SharedStorageService,
  StorageService,
} from "../infrastructure/storage/index.ts";
import type { ConfigFileService } from "../modules/config-file/index.ts";
import type { GitSourceService } from "../modules/git-source/index.ts";
import type { InternalService } from "../modules/internal/index.ts";
import type {
  SandboxProvisionService,
  SandboxRepository,
} from "../modules/sandbox/index.ts";
import type { SshKeyService } from "../modules/ssh-key/index.ts";
import type { WorkspaceService } from "../modules/workspace/index.ts";
import type {
  CreateSandboxBody,
  CreateSandboxResponse,
  GitHubSourceConfig,
  RepoConfig,
  Sandbox,
  SpawnTimings,
  Workspace,
} from "../schemas/index.ts";
import { config, isMock } from "../shared/lib/config.ts";
import { safeNanoid } from "../shared/lib/id.ts";
import { createChildLogger } from "../shared/lib/logger.ts";
import { killProcess } from "../shared/lib/shell.ts";

const log = createChildLogger("sandbox-spawner");

interface SandboxSpawnerDependencies {
  sandboxService: SandboxRepository;
  workspaceService: WorkspaceService;
  gitSourceService: GitSourceService;
  configFileService: ConfigFileService;
  sshKeyService: SshKeyService;
  internalService: InternalService;
  provisionService: SandboxProvisionService;
  agentClient: AgentClient;
  agentOperations: AgentOperations;
}

export class SandboxSpawner {
  constructor(private readonly deps: SandboxSpawnerDependencies) {}

  async spawn(options: CreateSandboxBody = {}): Promise<CreateSandboxResponse> {
    const context = new SpawnContext(this.deps, options);
    return context.execute();
  }
}

class SpawnContext {
  private sandboxId: string;
  private workspace?: Workspace;
  private sandbox?: Sandbox;
  private network?: NetworkAllocation;
  private paths?: SandboxPaths;
  private pid?: number;
  private client?: FirecrackerClient;
  private usedPrebuild = false;
  private hasVmSnapshot = false;

  private startTime = performance.now();
  private timings: Partial<SpawnTimings> = {};

  constructor(
    private readonly deps: SandboxSpawnerDependencies,
    private readonly options: CreateSandboxBody,
  ) {
    this.sandboxId = safeNanoid();
  }

  private async time<T>(
    key: keyof SpawnTimings,
    fn: () => Promise<T>,
  ): Promise<T> {
    const start = performance.now();
    const result = await fn();
    this.timings[key] = Math.round(performance.now() - start);
    return result;
  }

  async execute(): Promise<CreateSandboxResponse> {
    try {
      await this.time("loadWorkspace", () => this.loadWorkspace());
      await this.time("networkAndVolume", () =>
        Promise.all([
          this.allocateNetwork(),
          this.createVolume(),
          isMock() ? Promise.resolve() : this.createTapDevice(),
        ]),
      );
      await this.time("resizeVolume", () => this.resizeVolumeBeforeBoot());
      await this.time("initializeSandbox", () => this.initializeSandbox());

      if (isMock()) {
        return await this.finalizeMock();
      }

      await this.time("launchFirecracker", () => this.launchFirecracker());

      if (this.hasVmSnapshot && this.options.workspaceId) {
        await this.time("configureOrRestore", () => this.restoreFromSnapshot());
      } else {
        await this.time("configureOrRestore", async () => {
          await this.configureVm();
          await this.boot();
        });
      }

      await this.time("agentSetup", () => this.waitForAgentAndSetup());
      await this.time("postBoot", () => this.configurePostBoot());
      await this.time("registerRoutes", () => this.registerRoutes());

      return this.finalize();
    } catch (error) {
      log.error(
        {
          sandboxId: this.sandboxId,
          error: error instanceof Error ? error.message : error,
        },
        "Failed to spawn sandbox",
      );
      await this.rollback();
      throw error;
    }
  }

  private async loadWorkspace(): Promise<void> {
    if (this.options.workspaceId) {
      this.workspace = this.deps.workspaceService.getById(
        this.options.workspaceId,
      );
    }
  }

  private async allocateNetwork(): Promise<void> {
    this.network = await NetworkService.allocate(this.sandboxId);
    log.debug(
      { sandboxId: this.sandboxId, network: this.network },
      "Network allocated",
    );
  }

  private async createVolume(): Promise<void> {
    const baseImage =
      this.options.baseImage ?? this.workspace?.config.baseImage;
    const lvmAvailable = await StorageService.isAvailable();

    if (
      this.options.workspaceId &&
      this.workspace?.config.prebuild?.status === "ready"
    ) {
      this.usedPrebuild = await StorageService.hasPrebuild(
        this.options.workspaceId,
      );
      if (this.usedPrebuild) {
        const snapshotPaths = getPrebuildSnapshotPaths(
          this.options.workspaceId,
        );
        const [snapExists, memExists] = await Promise.all([
          Bun.file(snapshotPaths.snapshotFile).exists(),
          Bun.file(snapshotPaths.memFile).exists(),
        ]);
        this.hasVmSnapshot = snapExists && memExists;
      }
    }

    let lvmVolumePath: string | undefined;
    if (lvmAvailable) {
      lvmVolumePath = await StorageService.createSandboxVolume(this.sandboxId, {
        workspaceId: this.options.workspaceId,
        baseImage,
        usePrebuild: this.usedPrebuild,
      });
    }

    this.paths = getSandboxPaths(this.sandboxId, lvmVolumePath);
    log.debug(
      {
        sandboxId: this.sandboxId,
        useLvm: this.paths.useLvm,
        usedPrebuild: this.usedPrebuild,
      },
      "Volume created",
    );
  }

  private async resizeVolumeBeforeBoot(): Promise<void> {
    if (!this.paths?.useLvm) return;

    // Prebuild volumes are already at target size - skip resize
    if (this.usedPrebuild) {
      log.debug(
        { sandboxId: this.sandboxId },
        "Skipping volume resize (using prebuild)",
      );
      return;
    }

    const targetSizeGb = DEFAULTS.VOLUME_SIZE_GB;

    try {
      const currentSize = await StorageService.getVolumeSizeBytes(
        this.sandboxId,
      );
      const targetSizeBytes = targetSizeGb * 1024 * 1024 * 1024;

      if (currentSize >= targetSizeBytes) {
        log.debug(
          {
            sandboxId: this.sandboxId,
            currentSizeGb: Math.round(currentSize / 1024 / 1024 / 1024),
          },
          "Volume already at target size",
        );
        return;
      }

      const result = await StorageService.resizeSandboxVolume(
        this.sandboxId,
        targetSizeGb,
      );

      if (result.success) {
        log.info(
          {
            sandboxId: this.sandboxId,
            previousSizeGb: Math.round(
              result.previousSize / 1024 / 1024 / 1024,
            ),
            newSizeGb: targetSizeGb,
          },
          "Volume resized before boot",
        );
      } else {
        log.warn(
          { sandboxId: this.sandboxId, error: result.error },
          "Failed to resize volume before boot",
        );
      }
    } catch (error) {
      log.warn(
        { sandboxId: this.sandboxId, error },
        "Volume resize failed, continuing with original size",
      );
    }
  }

  private async initializeSandbox(): Promise<void> {
    if (!this.paths) throw new Error("Sandbox paths not initialized");
    if (!this.network) throw new Error("Network not allocated");

    const vcpus =
      this.options.vcpus ?? this.workspace?.config.vcpus ?? DEFAULTS.VCPUS;
    const memoryMb =
      this.options.memoryMb ??
      this.workspace?.config.memoryMb ??
      DEFAULTS.MEMORY_MB;

    this.sandbox = {
      id: this.sandboxId,
      status: "creating",
      workspaceId: this.options.workspaceId,
      runtime: {
        ipAddress: this.network.ipAddress,
        macAddress: this.network.macAddress,
        urls: { vscode: "", opencode: "", ssh: "" },
        vcpus,
        memoryMb,
      },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    this.deps.sandboxService.create(this.sandbox);
    log.info({ sandboxId: this.sandboxId }, "Sandbox initialized");
  }

  private async finalizeMock(): Promise<CreateSandboxResponse> {
    if (!this.sandbox) throw new Error("Sandbox not initialized");
    if (!this.network) throw new Error("Network not allocated");

    const sshCmd = await SshPiperService.registerRoute(
      this.sandboxId,
      this.network.ipAddress,
      this.deps.sshKeyService.getValidPublicKeys(),
    );

    this.sandbox.runtime.urls = {
      vscode: `https://sandbox-${this.sandboxId}.${config.domain.baseDomain}`,
      opencode: `https://opencode-${this.sandboxId}.${config.domain.baseDomain}`,
      ssh: sshCmd,
    };
    this.sandbox.status = "running";
    this.sandbox.runtime.pid = Math.floor(Math.random() * 100000);

    this.deps.sandboxService.update(this.sandboxId, this.sandbox);
    eventBus.emit({
      type: "sandbox.created",
      properties: {
        id: this.sandboxId,
        workspaceId: this.options.workspaceId,
      },
    });

    const totalTime = Math.round(performance.now() - this.startTime);
    const finalTimings: SpawnTimings = {
      total: totalTime,
      loadWorkspace: this.timings.loadWorkspace ?? 0,
      networkAndVolume: this.timings.networkAndVolume ?? 0,
      resizeVolume: this.timings.resizeVolume ?? 0,
      initializeSandbox: this.timings.initializeSandbox ?? 0,
      createTap: 0,
      launchFirecracker: 0,
      configureOrRestore: 0,
      agentSetup: 0,
      postBoot: 0,
      registerRoutes: 0,
    };

    log.info(
      { sandboxId: this.sandboxId, timings: finalTimings },
      "Mock sandbox created",
    );
    return { ...this.sandbox, timings: finalTimings };
  }

  private async createTapDevice(): Promise<void> {
    const tapDevice = `tap-${this.sandboxId.slice(0, 8)}`;
    await NetworkService.createTap(tapDevice);
  }

  private async launchFirecracker(): Promise<void> {
    if (!this.paths) throw new Error("Sandbox paths not initialized");

    const result = await launchFirecracker(this.paths);
    this.pid = result.pid;
    this.client = result.client;

    log.debug(
      { sandboxId: this.sandboxId, pid: result.pid },
      "Firecracker process started",
    );
  }

  private async configureVm(): Promise<void> {
    if (!this.client || !this.paths || !this.network || !this.sandbox) {
      throw new Error("VM prerequisites not initialized");
    }

    await configureVm(this.client, {
      paths: this.paths,
      macAddress: this.network.macAddress,
      tapDevice: this.network.tapDevice,
      vcpus: this.sandbox.runtime.vcpus,
      memoryMb: this.sandbox.runtime.memoryMb,
    });

    log.debug({ sandboxId: this.sandboxId }, "VM configured");
  }

  private async boot(): Promise<void> {
    await this.client?.start();
    await this.waitForBoot();
    log.debug({ sandboxId: this.sandboxId }, "VM booted");
  }

  private async restoreFromSnapshot(): Promise<void> {
    if (
      !this.client ||
      !this.paths ||
      !this.network ||
      !this.options.workspaceId ||
      !this.workspace
    ) {
      throw new Error("Snapshot restore prerequisites not initialized");
    }

    const snapshotPaths = getPrebuildSnapshotPaths(this.options.workspaceId);
    const prebuildSandboxId = this.workspace.config.prebuild?.latestId;
    if (!prebuildSandboxId) {
      throw new Error("Prebuild has no latestId");
    }

    // FC snapshot restore requires drive/vsock paths to match the original.
    // Drive: symlink original LVM path → new LVM volume
    // Vsock: FC recreates UDS at original path; we symlink new path to it after restore
    const originalPaths = getSandboxPaths(
      prebuildSandboxId,
      `/dev/sandbox-vg/sandbox-${prebuildSandboxId}`,
    );
    await $`sudo -n ln -sf ${this.paths.overlay} ${originalPaths.overlay}`.quiet();
    await $`rm -f ${originalPaths.vsock}`.quiet().nothrow();

    log.info({ sandboxId: this.sandboxId }, "Restoring from VM snapshot");
    await this.client.loadSnapshot(
      snapshotPaths.snapshotFile,
      snapshotPaths.memFile,
      {
        networkOverrides: [
          { iface_id: "eth0", host_dev_name: this.network.tapDevice },
        ],
      },
    );

    await this.waitForBoot();

    // FC creates vsock UDS at the original path after resume — poll until it exists
    const vsockDeadline = Date.now() + 5000;
    while (Date.now() < vsockDeadline) {
      const check = await $`test -S ${originalPaths.vsock}`.quiet().nothrow();
      if (check.exitCode === 0) break;
      await Bun.sleep(100);
    }

    await $`ln -sf ${originalPaths.vsock} ${this.paths.vsock}`.quiet();
    await $`sudo -n rm -f ${originalPaths.overlay}`.quiet().nothrow();

    log.info(
      { sandboxId: this.sandboxId },
      "Vsock symlink established after snapshot restore",
    );

    // Agent vsock listener survived the snapshot — connect and reconfigure guest
    await this.reconfigureRestoredGuest();

    log.info({ sandboxId: this.sandboxId }, "VM restored from snapshot");
  }

  private async reconfigureRestoredGuest(): Promise<void> {
    if (!this.network || !this.workspace) {
      throw new Error("Network or workspace not initialized");
    }

    const newIp = this.network.ipAddress;
    const gateway = this.network.gateway;

    await this.deps.agentClient.exec(
      this.sandboxId,
      `ip addr flush dev eth0 && ip addr add ${newIp}/24 dev eth0 && ip link set eth0 up && ip route replace default via ${gateway} dev eth0`,
      { timeout: 5000 },
    );

    log.info(
      { sandboxId: this.sandboxId, newIp },
      "Guest network reconfigured",
    );

    const imageInfo = await SharedStorageService.getBinariesImageInfo();
    if (imageInfo.exists) {
      const mountResult = await this.deps.agentClient.exec(
        this.sandboxId,
        `mknod -m 444 /dev/vdb b 254 16 2>/dev/null; mkdir -p /opt/shared && mount -o ro /dev/vdb /opt/shared`,
        { timeout: 5000 },
      );
      if (mountResult.exitCode === 0) {
        log.info(
          { sandboxId: this.sandboxId },
          "Shared binaries mounted in restored guest",
        );
      } else {
        log.warn(
          { sandboxId: this.sandboxId, stderr: mountResult.stderr },
          "Failed to mount shared binaries in restored guest",
        );
      }
    }

    await this.pushAuthAndConfigs();

    // Re-push secrets on every restore — they may have changed since prebuild
    await this.pushSecretsPostBoot();
    await this.pushGitCredentialsPostBoot();
    await this.pushFileSecretsPostBoot();

    const serviceNames = ["vscode", "opencode"];
    await this.deps.provisionService.startServices(
      this.sandboxId,
      serviceNames,
    );
    log.info({ sandboxId: this.sandboxId }, "Post-restore services launched");
  }

  private async waitForBoot(timeoutMs = 30000): Promise<void> {
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
      if (this.pid) {
        const alive = await $`kill -0 ${this.pid}`.quiet().nothrow();
        if (alive.exitCode !== 0) {
          const logContent = this.paths
            ? await Bun.file(this.paths.log)
                .text()
                .catch(() => "")
            : "";
          const lastLines = logContent.split("\n").slice(-20).join("\n");
          throw new Error(
            `Firecracker process died during boot:\n${lastLines}`,
          );
        }
      }

      try {
        if (await this.client?.isRunning()) return;
      } catch {}
      await Bun.sleep(50);
    }

    throw new Error(`VM boot timeout after ${timeoutMs}ms`);
  }

  private async waitForAgentAndSetup(): Promise<void> {
    if (!this.network) throw new Error("Network not allocated");

    // Skip for snapshot restore - reconfigureRestoredGuest() already handled everything
    if (this.hasVmSnapshot) {
      return;
    }

    const agentReady = await this.deps.agentClient.waitForAgent(
      this.sandboxId,
      { timeout: 60000 },
    );

    if (!agentReady) {
      log.warn({ sandboxId: this.sandboxId }, "Agent did not become ready");
      return;
    }

    await this.deps.provisionService.configureNetwork(this.sandboxId, {
      ipAddress: this.network.ipAddress,
      gateway: this.network.gateway,
    });

    await this.provisionPostBoot();

    await this.expandFilesystem();

    if (this.needsRepoClone()) {
      await this.cloneRepositories();
    }

    await this.pushAuthAndConfigs();
  }

  private async provisionPostBoot(): Promise<void> {
    const sandboxConfig = this.buildSandboxConfig();
    await this.deps.provisionService.pushSandboxConfig(
      this.sandboxId,
      sandboxConfig,
    );

    await this.deps.provisionService.setHostname(
      this.sandboxId,
      `sandbox-${this.sandboxId}`,
    );

    await this.pushSecretsPostBoot();
    await this.pushGitCredentialsPostBoot();
    await this.pushFileSecretsPostBoot();
    await this.pushOhMyOpenCodeCachePostBoot();
    await this.pushSandboxMdPostBoot();
  }

  private buildSandboxConfig(): SandboxConfig {
    const repos = (this.workspace?.config.repos ?? []).map((r) => ({
      clonePath: r.clonePath,
      branch: r.branch,
    }));

    const workspaceDir =
      repos.length === 1 && repos[0]?.clonePath
        ? `${VM.HOME}${repos[0].clonePath.startsWith("/workspace") ? repos[0].clonePath : `/workspace${repos[0].clonePath}`}`
        : VM.WORKSPACE_DIR;

    const dashboardDomain = config.domain.dashboard;
    const vsPort = config.advanced.vm.vscode.port;
    const ocPort = config.advanced.vm.opencode.port;
    const browserPort = config.advanced.vm.browser.port;
    const terminalPort = config.advanced.vm.terminal.port;

    return {
      sandboxId: this.sandboxId,
      workspaceId: this.workspace?.id,
      workspaceName: this.workspace?.name,
      repos,
      createdAt: new Date().toISOString(),
      network: {
        dashboardDomain,
        managerInternalUrl: `http://${config.network.bridgeIp}:${config.server.port}/internal`,
      },
      services: {
        vscode: {
          port: vsPort,
          command: `/opt/shared/bin/code-server --bind-addr 0.0.0.0:${vsPort} --auth none --disable-telemetry ${workspaceDir}`,
          user: "dev" as const,
          autoStart: true,
        },
        opencode: {
          port: ocPort,
          command: `cd ${workspaceDir} && /opt/shared/bin/opencode serve --hostname 0.0.0.0 --port ${ocPort} --cors https://${dashboardDomain}`,
          user: "dev" as const,
          autoStart: true,
        },
        terminal: {
          port: terminalPort,
          enabled: true,
        },
        kasmvnc: {
          port: browserPort,
          command: `Xvnc :99 -geometry 1280x900 -depth 24 -websocketPort ${browserPort} -SecurityTypes None -AlwaysShared -AcceptSetDesktopSize -DisableBasicAuth -UseIPv6 0 -interface 0.0.0.0 -httpd /usr/share/kasmvnc/www -FrameRate 60 -DynamicQualityMin 7 -DynamicQualityMax 9 -RectThreads 0 -CompareFB 2 -DetectScrolling -sslOnly 0`,
          user: "root" as const,
          autoStart: false,
        },
        openbox: {
          command: "openbox",
          user: "dev" as const,
          autoStart: false,
          env: { DISPLAY: ":99" },
        },
        chromium: {
          command:
            "chromium --disable-gpu --disable-software-rasterizer --disable-dev-shm-usage --no-first-run --disable-session-crashed-bubble --disable-infobars --disable-translate --disable-features=TranslateUI --password-store=basic --disable-background-networking --disable-sync --disable-extensions --disable-default-apps --disable-breakpad --disable-component-extensions-with-background-pages --disable-background-timer-throttling --force-device-scale-factor=1 --disable-lcd-text --renderer-process-limit=2 --disk-cache-size=104857600 --user-data-dir=/tmp/chromium-profile about:blank",
          user: "dev" as const,
          autoStart: false,
          env: { DISPLAY: ":99" },
        },
      },
    };
  }

  private async pushSecretsPostBoot(): Promise<void> {
    const secrets = this.workspace?.config.secrets;
    if (!secrets || Object.keys(secrets).length === 0) return;

    const decrypted = await SecretsService.decryptSecrets(secrets);
    const envFile = SecretsService.generateEnvFile(decrypted);
    await this.deps.provisionService.pushSecrets(this.sandboxId, envFile);
  }

  private async pushGitCredentialsPostBoot(): Promise<void> {
    const repos = this.workspace?.config.repos ?? [];
    const sourceIds = new Set<string>();

    for (const repo of repos) {
      if ("sourceId" in repo && repo.sourceId) {
        sourceIds.add(repo.sourceId);
      }
    }

    if (sourceIds.size === 0) return;

    const credentials: string[] = [];

    for (const sourceId of sourceIds) {
      const source = this.deps.gitSourceService.getById(sourceId);
      if (!source) continue;

      if (source.type === "github") {
        const ghConfig = source.config as GitHubSourceConfig;
        if (ghConfig.accessToken) {
          credentials.push(
            `https://x-access-token:${ghConfig.accessToken}@github.com`,
          );
        }
      }
    }

    if (credentials.length > 0) {
      await this.deps.provisionService.pushGitCredentials(
        this.sandboxId,
        credentials,
      );
    }
  }

  private async pushFileSecretsPostBoot(): Promise<void> {
    const fileSecrets = this.workspace?.config.fileSecrets;
    if (!fileSecrets || fileSecrets.length === 0) return;

    const decrypted = await SecretsService.decryptFileSecrets(fileSecrets);
    await this.deps.provisionService.pushFileSecrets(
      this.sandboxId,
      decrypted.map((s) => ({
        path: s.path,
        content: s.content,
        mode: s.mode,
      })),
    );
  }

  private async pushOhMyOpenCodeCachePostBoot(): Promise<void> {
    const configs = this.deps.configFileService.getMergedForSandbox(
      this.workspace?.id,
    );
    const authConfig = configs.find((c) => c.path === VM_PATHS.opencodeAuth);

    let providers: string[] = [];
    if (authConfig) {
      try {
        const authJson = JSON.parse(authConfig.content);
        providers = Object.keys(authJson);
      } catch {
        log.warn("Failed to parse auth.json for oh-my-opencode cache seed");
      }
    }

    await this.deps.provisionService.pushOhMyOpenCodeCache(
      this.sandboxId,
      providers,
    );
  }

  private async pushSandboxMdPostBoot(): Promise<void> {
    const content = this.generateSandboxMd();
    await this.deps.provisionService.pushSandboxMd(this.sandboxId, content);
  }

  private generateSandboxMd(): string {
    const ws = this.workspace;
    const reposSection = ws?.config.repos.length
      ? ws.config.repos
          .map((r) => {
            const name = "url" in r ? r.url : r.repo;
            return `- **${name}** (branch: \`${r.branch}\`, path: \`${VM.HOME}${r.clonePath}\`)`;
          })
          .join("\n")
      : "No repositories configured";

    const vsPort = config.advanced.vm.vscode.port;
    const ocPort = config.advanced.vm.opencode.port;

    const devCommandsSection = ws?.config.devCommands?.length
      ? ws.config.devCommands
          .map((cmd) => {
            const parts = [`\`${cmd.command}\``];
            if (cmd.workdir) parts.push(`workdir: \`${cmd.workdir}\``);
            if (cmd.port) parts.push(`port: ${cmd.port}`);
            return `- **${cmd.name}**: ${parts.join(", ")}`;
          })
          .join("\n")
      : "None configured";

    const secretsSection =
      ws?.config.secrets && Object.keys(ws.config.secrets).length > 0
        ? `Available in \`/etc/sandbox/secrets/.env\` (source with: \`source /etc/sandbox/secrets/.env\`)\nKeys: ${Object.keys(ws.config.secrets).join(", ")}`
        : "None configured";

    const fileSecretsSection = ws?.config.fileSecrets?.length
      ? ws.config.fileSecrets
          .map((s) => `- **${s.name}**: \`${s.path.replace(/^~/, VM.HOME)}\``)
          .join("\n")
      : "";

    return `# Sandbox: ${this.sandboxId}${ws ? ` (${ws.name})` : ""}

## Repositories
${reposSection}

## Services
| Service | Port | Logs |
|---------|------|------|
| code-server (VSCode) | ${vsPort} | \`/var/log/sandbox/vscode.log\` |
| opencode | ${ocPort} | \`/var/log/sandbox/opencode.log\` |
| sshd | 22 | — |

## Dev Commands
${devCommandsSection}

## Environment Secrets
${secretsSection}
${fileSecretsSection ? `\n## File Secrets\n${fileSecretsSection}` : ""}
## Paths
- Workspace: \`${VM.WORKSPACE_DIR}\`
- Config: \`/etc/sandbox/config.json\`
- Logs: \`/var/log/sandbox/\`
`;
  }

  private async configurePostBoot(): Promise<void> {
    if (this.hasVmSnapshot) {
      return;
    }

    const serviceNames = ["vscode", "opencode"];
    await this.deps.provisionService.startServices(
      this.sandboxId,
      serviceNames,
    );
    log.info({ sandboxId: this.sandboxId }, "Post-boot services started");
  }

  private async pushAuthAndConfigs(): Promise<void> {
    const result = await this.deps.internalService.syncAllToSandbox(
      this.sandboxId,
    );
    log.info(
      {
        sandboxId: this.sandboxId,
        authSynced: result.auth.synced,
        configsSynced: result.configs.synced,
        registry: result.registry,
      },
      "Auth, configs, and registry pushed to sandbox",
    );
  }

  private async expandFilesystem(): Promise<void> {
    if (!this.network || !this.paths?.useLvm) return;

    // Prebuild filesystems are already expanded - skip
    if (this.usedPrebuild) {
      log.debug(
        { sandboxId: this.sandboxId },
        "Skipping filesystem expansion (using prebuild)",
      );
      return;
    }

    try {
      const agentResult = await this.deps.agentOperations.resizeStorage(
        this.sandboxId,
      );

      if (agentResult.success) {
        log.info(
          { sandboxId: this.sandboxId, disk: agentResult.disk },
          "Filesystem expanded successfully",
        );
      } else {
        log.warn(
          { sandboxId: this.sandboxId, error: agentResult.error },
          "Failed to expand filesystem inside VM",
        );
      }
    } catch (error) {
      log.warn(
        { sandboxId: this.sandboxId, error },
        "Filesystem expansion failed",
      );
    }
  }

  private needsRepoClone(): boolean {
    return (
      !this.usedPrebuild &&
      !!this.workspace?.config.repos &&
      this.workspace.config.repos.length > 0
    );
  }

  private async cloneRepositories(): Promise<void> {
    if (!this.workspace?.config.repos) return;

    for (const repo of this.workspace.config.repos) {
      await this.cloneRepository(repo);
    }
  }

  private async cloneRepository(repo: RepoConfig): Promise<void> {
    if (!this.network) throw new Error("Network not allocated");

    const clonePath = `${VM.HOME}${repo.clonePath}`;
    const gitUrl =
      "url" in repo ? repo.url : await this.buildAuthenticatedUrl(repo);
    const branch = repo.branch;

    log.info(
      { sandboxId: this.sandboxId, branch, clonePath },
      "Cloning repository",
    );

    await this.deps.agentClient.exec(this.sandboxId, `rm -rf ${clonePath}`);

    const result = await this.deps.agentClient.exec(
      this.sandboxId,
      `git clone --depth 1 -b ${branch} ${gitUrl} ${clonePath}`,
      { timeout: 120000 },
    );

    if (result.exitCode !== 0) {
      log.error(
        { sandboxId: this.sandboxId, stderr: result.stderr },
        "Git clone failed",
      );
      throw new Error(`Git clone failed: ${result.stderr}`);
    }

    await this.deps.agentClient.exec(
      this.sandboxId,
      `chown -R dev:dev ${clonePath}`,
    );
    await this.deps.agentClient.exec(
      this.sandboxId,
      `su - dev -c 'git config --global --add safe.directory ${clonePath}'`,
    );
    log.info(
      { sandboxId: this.sandboxId, clonePath },
      "Repository cloned successfully",
    );
  }

  private async buildAuthenticatedUrl(repo: {
    sourceId: string;
    repo: string;
  }): Promise<string> {
    const source = this.deps.gitSourceService.getById(repo.sourceId);
    if (!source) {
      log.warn({ sourceId: repo.sourceId }, "Git source not found");
      return `https://github.com/${repo.repo}.git`;
    }

    if (source.type === "github") {
      const ghConfig = source.config as { accessToken?: string };
      if (ghConfig.accessToken) {
        return `https://x-access-token:${ghConfig.accessToken}@github.com/${repo.repo}.git`;
      }
    }

    return `https://github.com/${repo.repo}.git`;
  }

  private async registerRoutes(): Promise<void> {
    if (!this.network) throw new Error("Network not allocated");
    if (!this.sandbox) throw new Error("Sandbox not initialized");

    const urls = await CaddyService.registerRoutes(
      this.sandboxId,
      this.network.ipAddress,
      {
        vscode: config.advanced.vm.vscode.port,
        opencode: config.advanced.vm.opencode.port,
      },
    );

    const sshCmd = await SshPiperService.registerRoute(
      this.sandboxId,
      this.network.ipAddress,
      this.deps.sshKeyService.getValidPublicKeys(),
    );

    this.sandbox.runtime.urls = {
      ...urls,
      ssh: sshCmd,
    };
  }

  private finalize(): CreateSandboxResponse {
    if (!this.sandbox) throw new Error("Sandbox not initialized");
    this.sandbox.status = "running";
    this.sandbox.runtime.pid = this.pid;

    this.deps.sandboxService.update(this.sandboxId, this.sandbox);
    eventBus.emit({
      type: "sandbox.created",
      properties: {
        id: this.sandboxId,
        workspaceId: this.options.workspaceId,
      },
    });

    const totalTime = Math.round(performance.now() - this.startTime);
    const finalTimings: SpawnTimings = {
      total: totalTime,
      loadWorkspace: this.timings.loadWorkspace ?? 0,
      networkAndVolume: this.timings.networkAndVolume ?? 0,
      resizeVolume: this.timings.resizeVolume ?? 0,
      initializeSandbox: this.timings.initializeSandbox ?? 0,
      createTap: this.timings.createTap ?? 0,
      launchFirecracker: this.timings.launchFirecracker ?? 0,
      configureOrRestore: this.timings.configureOrRestore ?? 0,
      agentSetup: this.timings.agentSetup ?? 0,
      postBoot: this.timings.postBoot ?? 0,
      registerRoutes: this.timings.registerRoutes ?? 0,
    };

    log.info(
      {
        sandboxId: this.sandboxId,
        pid: this.pid,
        useLvm: this.paths?.useLvm,
        timings: finalTimings,
      },
      "Sandbox created successfully",
    );

    return { ...this.sandbox, timings: finalTimings };
  }

  private async rollback(): Promise<void> {
    log.warn({ sandboxId: this.sandboxId }, "Rolling back sandbox creation");

    if (this.pid) {
      await killProcess(this.pid);
    }

    if (this.paths) {
      await $`rm -f ${this.paths.socket} ${this.paths.vsock} ${this.paths.pid} ${this.paths.log}`
        .quiet()
        .nothrow();

      if (this.paths.useLvm) {
        await StorageService.deleteSandboxVolume(this.sandboxId);
      } else {
        await $`rm -f ${this.paths.overlay}`.quiet().nothrow();
      }
    }

    if (this.network) {
      await NetworkService.deleteTap(this.network.tapDevice);
      NetworkService.release(this.network.ipAddress);
    }

    await CaddyService.removeRoutes(this.sandboxId);
    await SshPiperService.removeRoute(this.sandboxId);

    try {
      this.deps.sandboxService.updateStatus(
        this.sandboxId,
        "error",
        "Build failed",
      );
    } catch {}
  }
}
