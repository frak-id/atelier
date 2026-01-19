import { FIRECRACKER } from "@frak-sandbox/shared/constants";
import { $ } from "bun";
import { nanoid } from "nanoid";
import type { AgentClient } from "../../infrastructure/agent/index.ts";
import {
  FirecrackerClient,
  getSandboxPaths,
  type SandboxPaths,
} from "../../infrastructure/firecracker/index.ts";
import {
  type NetworkAllocation,
  NetworkService,
} from "../../infrastructure/network/index.ts";
import { CaddyService } from "../../infrastructure/proxy/index.ts";
import { StorageService } from "../../infrastructure/storage/index.ts";
import type {
  CreateSandboxBody,
  GitHubSourceConfig,
  RepoConfig,
  Sandbox,
  Workspace,
} from "../../schemas/index.ts";
import { config } from "../../shared/lib/config.ts";
import { createChildLogger } from "../../shared/lib/logger.ts";
import { ensureDir } from "../../shared/lib/shell.ts";
import { SandboxProvisioner } from "./sandbox.provisioner.ts";
import type { SandboxRepository } from "./sandbox.repository.ts";

const log = createChildLogger("sandbox-builder");

const VSCODE_PORT = 8080;
const OPENCODE_PORT = 3000;
const TERMINAL_PORT = 7681;

type GitSourceGetter = (
  id: string,
) => { type: string; config: unknown } | undefined;
type ConfigFilesGetter = (workspaceId?: string) => {
  path: string;
  content: string;
  contentType: "json" | "text" | "binary";
}[];
type WorkspaceGetter = (id: string) => Workspace | undefined;

interface BuilderDependencies {
  getWorkspace: WorkspaceGetter;
  getGitSource: GitSourceGetter;
  getConfigFiles: ConfigFilesGetter;
  agentClient: AgentClient;
}

export class SandboxBuilder {
  private sandboxId: string;
  private options: CreateSandboxBody;
  private deps: BuilderDependencies;
  private workspace?: Workspace;
  private sandbox?: Sandbox;
  private network?: NetworkAllocation;
  private paths?: SandboxPaths;
  private pid?: number;
  private client?: FirecrackerClient;
  private usedPrebuild = false;

  private constructor(
    private readonly sandboxRepository: SandboxRepository,
    options: CreateSandboxBody,
    deps: BuilderDependencies,
  ) {
    this.sandboxId = nanoid(12);
    this.options = options;
    this.deps = deps;
  }

  static create(
    sandboxRepository: SandboxRepository,
    options: CreateSandboxBody,
    deps: BuilderDependencies,
  ): SandboxBuilder {
    return new SandboxBuilder(sandboxRepository, options, deps);
  }

  async build(): Promise<Sandbox> {
    try {
      await this.loadWorkspace();
      await this.allocateNetwork();
      await this.createVolume();
      await this.initializeSandbox();

      if (config.isMock()) {
        return this.finalizeMock();
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
        "Failed to build sandbox",
      );
      await this.rollback();
      throw error;
    }
  }

  private async loadWorkspace(): Promise<void> {
    if (this.options.workspaceId) {
      this.workspace = this.deps.getWorkspace(this.options.workspaceId);
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

    this.sandboxRepository.create(this.sandbox);
    log.info({ sandboxId: this.sandboxId }, "Sandbox initialized");
  }

  private finalizeMock(): Sandbox {
    if (!this.sandbox) throw new Error("Sandbox not initialized");

    this.sandbox.runtime.urls = {
      vscode: `https://sandbox-${this.sandboxId}.${config.caddy.domainSuffix}`,
      opencode: `https://opencode-${this.sandboxId}.${config.caddy.domainSuffix}`,
      terminal: `https://terminal-${this.sandboxId}.${config.caddy.domainSuffix}`,
      ssh: `ssh root@${this.network?.ipAddress}`,
    };
    this.sandbox.status = "running";
    this.sandbox.runtime.pid = Math.floor(Math.random() * 100000);

    this.sandboxRepository.update(this.sandboxId, this.sandbox);
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

    await SandboxProvisioner.provision({
      sandboxId: this.sandboxId,
      workspace: this.workspace,
      network: this.network,
      paths: this.paths,
      getGitSource: this.deps.getGitSource,
      getConfigFiles: this.deps.getConfigFiles,
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
    const agentReady = await this.deps.agentClient.waitForAgent(
      this.sandboxId,
      {
        timeout: 60000,
      },
    );

    if (!agentReady) {
      log.warn({ sandboxId: this.sandboxId }, "Agent did not become ready");
      return;
    }

    if (this.needsRepoClone()) {
      await this.cloneRepositories();
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
    const clonePath = `/home/dev${repo.clonePath}`;
    const gitUrl = "url" in repo ? repo.url : await this.resolveSourceUrl(repo);
    const branch = repo.branch;

    log.info(
      { sandboxId: this.sandboxId, gitUrl, branch, clonePath },
      "Cloning repository in sandbox",
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

  private async resolveSourceUrl(repo: {
    sourceId: string;
    repo: string;
    branch: string;
    clonePath: string;
  }): Promise<string> {
    const source = this.deps.getGitSource(repo.sourceId);
    if (!source) {
      log.warn(
        { sourceId: repo.sourceId },
        "Git source not found, using public URL",
      );
      return `https://github.com/${repo.repo}.git`;
    }

    if (source.type === "github") {
      const ghConfig = source.config as GitHubSourceConfig;
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

    this.sandbox.runtime.urls = {
      ...urls,
      ssh: `ssh root@${this.network?.ipAddress}`,
    };
  }

  private finalize(): Sandbox {
    if (!this.sandbox) throw new Error("Sandbox not initialized");
    this.sandbox.status = "running";
    this.sandbox.runtime.pid = this.pid;

    this.sandboxRepository.update(this.sandboxId, this.sandbox);
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

    try {
      this.sandboxRepository.updateStatus(
        this.sandboxId,
        "error",
        "Build failed",
      );
    } catch {}
  }
}
