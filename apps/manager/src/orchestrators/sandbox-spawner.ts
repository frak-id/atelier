import { DEFAULTS, FIRECRACKER } from "@frak-sandbox/shared/constants";
import { $ } from "bun";
import { nanoid } from "nanoid";
import type { AgentClient } from "../infrastructure/agent/index.ts";
import {
  FirecrackerClient,
  getSandboxPaths,
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
import { StorageService } from "../infrastructure/storage/index.ts";
import type { ConfigFileService } from "../modules/config-file/index.ts";
import type { GitSourceService } from "../modules/git-source/index.ts";
import type { SandboxService } from "../modules/sandbox/index.ts";
import { SandboxProvisioner } from "../modules/sandbox/sandbox.provisioner.ts";
import type { WorkspaceService } from "../modules/workspace/index.ts";
import type {
  CreateSandboxBody,
  RepoConfig,
  Sandbox,
  Workspace,
} from "../schemas/index.ts";
import { config } from "../shared/lib/config.ts";
import { createChildLogger } from "../shared/lib/logger.ts";
import { ensureDir } from "../shared/lib/shell.ts";

const log = createChildLogger("sandbox-spawner");

const VSCODE_PORT = 8080;
const OPENCODE_PORT = 3000;
const TERMINAL_PORT = 7681;

interface SandboxSpawnerDependencies {
  sandboxService: SandboxService;
  workspaceService: WorkspaceService;
  gitSourceService: GitSourceService;
  configFileService: ConfigFileService;
  agentClient: AgentClient;
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

  constructor(
    private readonly deps: SandboxSpawnerDependencies,
    private readonly options: CreateSandboxBody,
  ) {
    this.sandboxId = nanoid(12);
  }

  async execute(): Promise<Sandbox> {
    try {
      await this.loadWorkspace();
      await this.allocateNetwork();
      await this.createVolume();
      await this.resizeVolumeBeforeBoot();
      await this.initializeSandbox();

      if (config.isMock()) {
        return await this.finalizeMock();
      }

      await this.createTapDevice();
      await this.provisionFilesystem();
      await this.launchFirecracker();
      await this.configureVm();
      await this.boot();
      await this.waitForAgentAndSetup();
      await this.registerRoutes();

      return this.finalize();
    } catch (error) {
      log.error(
        { sandboxId: this.sandboxId, error },
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

    await ensureDir(config.paths.SOCKET_DIR);
    await ensureDir(config.paths.LOG_DIR);

    await $`rm -f ${this.paths.socket}`.quiet().nothrow();
    await $`touch ${this.paths.log}`.quiet();

    const proc = Bun.spawn(
      [
        FIRECRACKER.BINARY_PATH,
        "--api-sock",
        this.paths.socket,
        "--log-path",
        this.paths.log,
        "--level",
        "Warning",
      ],
      { stdout: "ignore", stderr: "ignore", stdin: "ignore" },
    );

    this.pid = proc.pid;
    await Bun.write(this.paths.pid, String(proc.pid));
    await Bun.sleep(50);

    const alive = await $`kill -0 ${proc.pid}`.quiet().nothrow();
    if (alive.exitCode !== 0) {
      const logContent = await Bun.file(this.paths.log)
        .text()
        .catch(() => "");
      log.error(
        { sandboxId: this.sandboxId, log: logContent },
        "Firecracker failed to start",
      );
      throw new Error("Firecracker process died on startup");
    }

    this.client = new FirecrackerClient(this.paths.socket);
    log.debug(
      { sandboxId: this.sandboxId, pid: proc.pid },
      "Firecracker process started",
    );
  }

  private async configureVm(): Promise<void> {
    if (!this.client || !this.paths || !this.network || !this.sandbox) {
      throw new Error("VM prerequisites not initialized");
    }

    const bootArgs =
      "console=ttyS0 reboot=k panic=1 pci=off init=/etc/sandbox/sandbox-init.sh";

    await this.client.setBootSource(this.paths.kernel, bootArgs);
    await this.client.setDrive("rootfs", this.paths.overlay, true);
    await this.client.setNetworkInterface(
      "eth0",
      this.network.macAddress,
      this.network.tapDevice,
    );

    const cpuTemplatePath = `${config.paths.SANDBOX_DIR}/cpu-template-no-avx.json`;
    const cpuTemplateApplied = await this.client.setCpuConfig(cpuTemplatePath);
    if (cpuTemplateApplied) {
      log.info(
        { sandboxId: this.sandboxId },
        "CPU template applied (AVX disabled)",
      );
    }

    await this.client.setMachineConfig(
      this.sandbox.runtime.vcpus,
      this.sandbox.runtime.memoryMb,
    );

    log.debug({ sandboxId: this.sandboxId }, "VM configured");
  }

  private async boot(): Promise<void> {
    await this.client?.start();
    await this.waitForBoot();
    log.debug({ sandboxId: this.sandboxId }, "VM booted");
  }

  private async waitForBoot(timeoutMs = 30000): Promise<void> {
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
      try {
        if (await this.client?.isRunning()) return;
      } catch {}
      await Bun.sleep(200);
    }

    throw new Error(`VM boot timeout after ${timeoutMs}ms`);
  }

  private async waitForAgentAndSetup(): Promise<void> {
    if (!this.network) throw new Error("Network not allocated");

    const agentReady = await this.deps.agentClient.waitForAgent(
      this.network.ipAddress,
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
  }

  private async expandFilesystem(): Promise<void> {
    if (!this.network || !this.paths?.useLvm) return;

    try {
      const agentResult = await this.deps.agentClient.resizeStorage(
        this.network.ipAddress,
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

    await this.deps.agentClient.exec(
      this.network.ipAddress,
      `rm -rf ${clonePath}`,
    );

    const result = await this.deps.agentClient.exec(
      this.network.ipAddress,
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
      this.network.ipAddress,
      `chown -R dev:dev ${clonePath}`,
    );
    await this.deps.agentClient.exec(
      this.network.ipAddress,
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
        vscode: VSCODE_PORT,
        opencode: OPENCODE_PORT,
        terminal: TERMINAL_PORT,
      },
    );

    const sshCmd = await SshPiperService.registerRoute(
      this.sandboxId,
      this.network.ipAddress,
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
      await $`kill ${this.pid} 2>/dev/null || true`.quiet().nothrow();
      await Bun.sleep(100);
      await $`kill -9 ${this.pid} 2>/dev/null || true`.quiet().nothrow();
    }

    if (this.paths) {
      await $`rm -f ${this.paths.socket} ${this.paths.pid}`.quiet().nothrow();

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
