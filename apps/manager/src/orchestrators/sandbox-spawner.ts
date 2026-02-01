import { DEFAULTS } from "@frak-sandbox/shared/constants";
import { $ } from "bun";
import type {
  AgentClient,
  AgentOperations,
} from "../infrastructure/agent/index.ts";
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
import {
  SharedStorageService,
  StorageService,
} from "../infrastructure/storage/index.ts";
import type { ConfigFileService } from "../modules/config-file/index.ts";
import type { GitSourceService } from "../modules/git-source/index.ts";
import type { InternalService } from "../modules/internal/index.ts";
import type { SandboxRepository } from "../modules/sandbox/index.ts";
import { SandboxProvisioner } from "../modules/sandbox/sandbox.provisioner.ts";
import type { SshKeyService } from "../modules/ssh-key/index.ts";
import type { WorkspaceService } from "../modules/workspace/index.ts";
import type {
  CreateSandboxBody,
  RepoConfig,
  Sandbox,
  Workspace,
} from "../schemas/index.ts";
import { config } from "../shared/lib/config.ts";
import { createChildLogger } from "../shared/lib/logger.ts";
import { killProcess } from "../shared/lib/shell.ts";
import { safeNanoid } from "../shared/lib/id.ts";

const log = createChildLogger("sandbox-spawner");

interface SandboxSpawnerDependencies {
  sandboxService: SandboxRepository;
  workspaceService: WorkspaceService;
  gitSourceService: GitSourceService;
  configFileService: ConfigFileService;
  sshKeyService: SshKeyService;
  internalService: InternalService;
  agentClient: AgentClient;
  agentOperations: AgentOperations;
}

export class SandboxSpawner {
  constructor(private readonly deps: SandboxSpawnerDependencies) {}

  async spawn(options: CreateSandboxBody = {}): Promise<Sandbox> {
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

  constructor(
    private readonly deps: SandboxSpawnerDependencies,
    private readonly options: CreateSandboxBody,
  ) {
    this.sandboxId = safeNanoid();
  }

  async execute(): Promise<Sandbox> {
    try {
      await this.loadWorkspace();
      await Promise.all([this.allocateNetwork(), this.createVolume()]);
      await this.resizeVolumeBeforeBoot();
      await this.initializeSandbox();

      if (config.isMock()) {
        return await this.finalizeMock();
      }

      await Promise.all([this.createTapDevice(), this.provisionFilesystem()]);
      await this.launchFirecracker();

      if (this.hasVmSnapshot && this.options.workspaceId) {
        await this.restoreFromSnapshot();
      } else {
        await this.configureVm();
        await this.boot();
      }

      await this.waitForAgentAndSetup();
      await this.registerRoutes();

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
        const snapExists = await Bun.file(snapshotPaths.snapshotFile).exists();
        const memExists = await Bun.file(snapshotPaths.memFile).exists();
        this.hasVmSnapshot = snapExists && memExists;
      }
    }

    let lvmVolumePath: string | undefined;
    if (lvmAvailable) {
      lvmVolumePath = await StorageService.createSandboxVolume(this.sandboxId, {
        workspaceId: this.options.workspaceId,
        baseImage,
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
      this.options.vcpus ??
      this.workspace?.config.vcpus ??
      config.defaults.VCPUS;
    const memoryMb =
      this.options.memoryMb ??
      this.workspace?.config.memoryMb ??
      config.defaults.MEMORY_MB;

    this.sandbox = {
      id: this.sandboxId,
      status: "creating",
      workspaceId: this.options.workspaceId,
      runtime: {
        ipAddress: this.network.ipAddress,
        macAddress: this.network.macAddress,
        urls: { vscode: "", opencode: "", terminal: "", ssh: "" },
        vcpus,
        memoryMb,
      },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    this.deps.sandboxService.create(this.sandbox);
    log.info({ sandboxId: this.sandboxId }, "Sandbox initialized");
  }

  private async finalizeMock(): Promise<Sandbox> {
    if (!this.sandbox) throw new Error("Sandbox not initialized");
    if (!this.network) throw new Error("Network not allocated");

    const sshCmd = await SshPiperService.registerRoute(
      this.sandboxId,
      this.network.ipAddress,
      this.deps.sshKeyService.getValidPublicKeys(),
    );

    this.sandbox.runtime.urls = {
      vscode: `https://sandbox-${this.sandboxId}.${config.caddy.domainSuffix}`,
      opencode: `https://opencode-${this.sandboxId}.${config.caddy.domainSuffix}`,
      terminal: `https://terminal-${this.sandboxId}.${config.caddy.domainSuffix}`,
      ssh: sshCmd,
    };
    this.sandbox.status = "running";
    this.sandbox.runtime.pid = Math.floor(Math.random() * 100000);

    this.deps.sandboxService.update(this.sandboxId, this.sandbox);
    log.info({ sandboxId: this.sandboxId }, "Mock sandbox created");
    return this.sandbox;
  }

  private async createTapDevice(): Promise<void> {
    if (!this.network) throw new Error("Network not allocated");
    await NetworkService.createTap(this.network.tapDevice);
  }

  private async provisionFilesystem(): Promise<void> {
    if (!this.paths || !this.network) {
      throw new Error("Paths or network not initialized");
    }

    const getGitSource = (id: string) => this.deps.gitSourceService.getById(id);
    const getConfigFiles = (workspaceId?: string) =>
      this.deps.configFileService.getMergedForSandbox(workspaceId);

    await SandboxProvisioner.provision({
      sandboxId: this.sandboxId,
      workspace: this.workspace,
      network: this.network,
      paths: this.paths,
      getGitSource,
      getConfigFiles,
    });
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
    await $`ln -sf ${this.paths.overlay} ${originalPaths.overlay}`.quiet();
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
    await $`rm -f ${originalPaths.overlay}`.quiet().nothrow();

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

    // Push latest auth and configs BEFORE launching services so opencode
    // reads up-to-date credentials instead of stale prebuild data.
    await this.pushAuthAndConfigs();

    const workspaceDir = this.workspace.config.repos?.[0]?.clonePath
      ? `/home/dev${this.workspace.config.repos[0].clonePath}`
      : "/home/dev/workspace";
    const dashboardDomain =
      config.domains?.dashboard ?? "sandbox-dash.nivelais.com";
    const opencodePort = config.raw.services.opencode.port;
    const vscodePort = config.raw.services.vscode.port;
    const terminalPort = config.raw.services.terminal.port;

    const servicesCmd = [
      `(setsid su - dev -c "/opt/shared/bin/code-server --bind-addr 0.0.0.0:${vscodePort} --auth none --disable-telemetry ${workspaceDir} > /var/log/sandbox/code-server.log 2>&1" </dev/null &>/dev/null &)`,
      `(setsid su - dev -c "cd ${workspaceDir} && /opt/shared/bin/opencode serve --hostname 0.0.0.0 --port ${opencodePort} --cors https://${dashboardDomain} > /var/log/sandbox/opencode.log 2>&1" </dev/null &>/dev/null &)`,
      `(setsid ttyd -p ${terminalPort} -W -t fontSize=14 -t fontFamily=monospace su - dev </dev/null > /var/log/sandbox/ttyd.log 2>&1 &)`,
    ].join("\n");

    // Fire-and-forget: don't block on service startup
    this.deps.agentClient
      .exec(this.sandboxId, servicesCmd, {
        timeout: 10000,
      })
      .catch((err) => {
        log.warn(
          { sandboxId: this.sandboxId, error: String(err) },
          "Service restart exec failed (non-blocking)",
        );
      });

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

    const agentReady = await this.deps.agentClient.waitForAgent(
      this.sandboxId,
      { timeout: 60000 },
    );

    if (!agentReady) {
      log.warn({ sandboxId: this.sandboxId }, "Agent did not become ready");
      return;
    }

    await this.expandFilesystem();

    if (this.needsRepoClone()) {
      await this.cloneRepositories();
    }

    await this.pushAuthAndConfigs();
  }

  private async pushAuthAndConfigs(): Promise<void> {
    const [authResult, configResult] = await Promise.allSettled([
      this.deps.internalService.syncAuthToSandbox(this.sandboxId),
      this.deps.internalService.syncConfigsToSandbox(this.sandboxId),
    ]);

    if (authResult.status === "fulfilled") {
      log.info(
        { sandboxId: this.sandboxId, synced: authResult.value.synced },
        "Auth pushed to sandbox",
      );
    } else {
      log.warn(
        { sandboxId: this.sandboxId, error: authResult.reason },
        "Failed to push auth to sandbox",
      );
    }

    if (configResult.status === "fulfilled") {
      log.info(
        { sandboxId: this.sandboxId, synced: configResult.value.synced },
        "Configs pushed to sandbox",
      );
    } else {
      log.warn(
        { sandboxId: this.sandboxId, error: configResult.reason },
        "Failed to push configs to sandbox",
      );
    }
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

    const clonePath = `/home/dev${repo.clonePath}`;
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
        vscode: config.raw.services.vscode.port,
        opencode: config.raw.services.opencode.port,
        terminal: config.raw.services.terminal.port,
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

  private finalize(): Sandbox {
    if (!this.sandbox) throw new Error("Sandbox not initialized");
    this.sandbox.status = "running";
    this.sandbox.runtime.pid = this.pid;

    this.deps.sandboxService.update(this.sandboxId, this.sandbox);
    log.info(
      { sandboxId: this.sandboxId, pid: this.pid, useLvm: this.paths?.useLvm },
      "Sandbox created successfully",
    );

    return this.sandbox;
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
