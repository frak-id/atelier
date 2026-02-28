import { DEFAULTS, VM } from "@frak/atelier-shared/constants";
import { $ } from "bun";
import { customAlphabet } from "nanoid";
import type {
  AgentClient,
  AgentOperations,
} from "../infrastructure/agent/index.ts";
import { eventBus } from "../infrastructure/events/index.ts";
import {
  configureVm,
  type FirecrackerClient,
  getSandboxPaths,
  launchFirecracker,
  type SandboxPaths,
} from "../infrastructure/firecracker/index.ts";
import {
  type NetworkAllocation,
  networkService,
} from "../infrastructure/network/index.ts";
import {
  proxyService,
  SshPiperService,
} from "../infrastructure/proxy/index.ts";
import { StorageService } from "../infrastructure/storage/index.ts";
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
  RepoConfig,
  Sandbox,
  Workspace,
} from "../schemas/index.ts";
import { config, isMock } from "../shared/lib/config.ts";
import { safeNanoid } from "../shared/lib/id.ts";
import { createChildLogger } from "../shared/lib/logger.ts";
import { killProcess } from "../shared/lib/shell.ts";
import {
  resolveProfile,
  type SandboxIntent,
  type SandboxProfile,
} from "./sandbox-profile.ts";
import {
  buildAuthenticatedGitUrl,
  provisionGuest,
} from "./sandbox-provisioning.ts";

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
  private readonly intent: SandboxIntent;
  private profile?: SandboxProfile;
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
    this.sandboxId = safeNanoid();
    if (options.system) {
      this.intent = { kind: "system" };
      return;
    }

    const workspaceId = options.workspaceId;
    if (!workspaceId) {
      throw new Error("workspaceId is required for workspace sandbox");
    }

    this.intent = { kind: "workspace", workspaceId };
  }

  async execute(): Promise<CreateSandboxResponse> {
    try {
      await this.loadWorkspace();
      await Promise.all([
        this.allocateNetwork(),
        this.createVolume(),
        isMock() ? Promise.resolve() : this.createTapDevice(),
      ]);
      this.profile = resolveProfile(
        this.intent,
        this.workspace,
        this.usedPrebuild,
      );
      await this.resizeVolumeBeforeBoot();
      await this.initializeSandbox();

      if (isMock()) {
        return await this.finalizeMock();
      }

      await this.launchFirecracker();
      await this.configureVm();
      await this.boot();
      await this.setupAgent();
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
    if (this.options.workspaceId && this.intent.kind === "workspace") {
      this.workspace = this.deps.workspaceService.getById(
        this.options.workspaceId,
      );
    }
  }

  private async allocateNetwork(): Promise<void> {
    this.network = await networkService.allocate(this.sandboxId);
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
      (this.intent.kind === "system" ||
        this.workspace?.config.prebuild?.status === "ready")
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
    if (!this.profile?.resizeVolume) return;

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
    const generatePassword = customAlphabet(
      "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789",
    );
    const opencodePassword = generatePassword(32);

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
        opencodePassword,
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

    log.info({ sandboxId: this.sandboxId }, "Mock sandbox created");
    return this.sandbox;
  }

  private async createTapDevice(): Promise<void> {
    const tapDevice = `tap-${this.sandboxId.slice(0, 8)}`;
    await networkService.createTap(tapDevice);
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
      ipAddress: this.network.ipAddress,
      gateway: this.network.gateway,
    });

    log.debug({ sandboxId: this.sandboxId }, "VM configured");
  }

  private async boot(): Promise<void> {
    await this.client?.start();

    // Boot check and agent polling run concurrently — vsock attempts fail
    // cheaply during early boot (~50 ms each) and succeed once the kernel
    // driver + agent are ready.
    const [, agentReady] = await Promise.all([
      this.waitForBoot(),
      this.deps.agentClient.waitForAgent(this.sandboxId, { timeout: 60000 }),
    ]);

    if (!agentReady) {
      log.warn({ sandboxId: this.sandboxId }, "Agent did not become ready");
    }

    log.debug({ sandboxId: this.sandboxId }, "VM booted and agent ready");
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

  private async setupAgent(): Promise<void> {
    if (!this.network || !this.profile) {
      throw new Error("Network or sandbox profile not initialized");
    }

    await provisionGuest(
      this.sandboxId,
      this.profile,
      "create",
      {
        provisionService: this.deps.provisionService,
        agentClient: this.deps.agentClient,
        agentOperations: this.deps.agentOperations,
        internalService: this.deps.internalService,
        workspaceService: this.deps.workspaceService,
        gitSourceService: this.deps.gitSourceService,
        configFileService: this.deps.configFileService,
      },
      this.sandbox?.runtime.opencodePassword,
    );

    if (this.profile.setupSwap) {
      await this.setupSwap();
    }

    if (this.profile.cloneRepos && this.workspace?.config.repos?.length) {
      for (const repo of this.workspace.config.repos) {
        await this.cloneRepository(repo);
      }
    }

    if (this.profile.pushGitCredentials) {
      await this.sanitizeGitRemoteUrls();
    }
  }

  private async sanitizeGitRemoteUrls(): Promise<void> {
    const repos = this.workspace?.config.repos ?? [];
    if (repos.length === 0) return;

    for (const repo of repos) {
      const clonePath = `${VM.HOME}${repo.clonePath}`;
      const result = await this.deps.agentClient.exec(
        this.sandboxId,
        `git -C '${clonePath}' remote get-url origin 2>/dev/null`,
        { timeout: 5000, user: "dev" },
      );

      if (result.exitCode !== 0) continue;

      const currentUrl = result.stdout.trim();
      const cleanUrl = currentUrl.replace(/^(https?:\/\/)[^@]+@/, "$1");

      if (cleanUrl !== currentUrl) {
        await this.deps.agentClient.exec(
          this.sandboxId,
          `git -C '${clonePath}' remote set-url origin '${cleanUrl}'`,
          { timeout: 5000, user: "dev" },
        );
        log.debug(
          { sandboxId: this.sandboxId, clonePath },
          "Sanitized git remote URL",
        );
      }
    }
  }

  private async setupSwap(): Promise<void> {
    if (!this.paths?.useLvm) {
      log.debug({ sandboxId: this.sandboxId }, "Skipping swap setup (no LVM)");
      return;
    }

    try {
      const result = await this.deps.agentClient.exec(
        this.sandboxId,
        "/etc/sandbox/setup-swap.sh",
        { timeout: 30000 },
      );

      if (result.exitCode === 0) {
        log.info(
          { sandboxId: this.sandboxId, output: result.stdout.trim() },
          "Swap setup completed",
        );
      } else {
        log.warn(
          { sandboxId: this.sandboxId, stderr: result.stderr },
          "Swap setup failed (non-critical)",
        );
      }
    } catch (error) {
      log.warn(
        { sandboxId: this.sandboxId, error },
        "Swap setup failed (non-critical)",
      );
    }
  }

  private async cloneRepository(repo: RepoConfig): Promise<void> {
    if (!this.network) throw new Error("Network not allocated");

    const clonePath = `${VM.HOME}${repo.clonePath}`;
    const gitUrl =
      "url" in repo
        ? repo.url
        : await buildAuthenticatedGitUrl(repo, this.deps.gitSourceService);
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
      `git config --global --add safe.directory ${clonePath}`,
      { user: "dev" },
    );
    log.info(
      { sandboxId: this.sandboxId, clonePath },
      "Repository cloned successfully",
    );
  }

  private async registerRoutes(): Promise<void> {
    if (!this.network) throw new Error("Network not allocated");
    if (!this.sandbox) throw new Error("Sandbox not initialized");
    if (!this.profile) throw new Error("Sandbox profile not initialized");

    const sshCmd = await SshPiperService.registerRoute(
      this.sandboxId,
      this.network.ipAddress,
      this.deps.sshKeyService.getValidPublicKeys(),
    );

    if (this.profile.routePattern === "opencode-only") {
      const opencodeUrl = await proxyService.registerOpenCodeRoute(
        this.sandboxId,
        this.network.ipAddress,
        config.advanced.vm.opencode.port,
      );
      this.sandbox.runtime.urls = {
        vscode: "",
        opencode: opencodeUrl,
        ssh: sshCmd,
      };
      return;
    }

    const urls = await proxyService.registerRoutes(
      this.sandboxId,
      this.network.ipAddress,
      {
        vscode: config.advanced.vm.vscode.port,
        opencode: config.advanced.vm.opencode.port,
      },
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

    log.info(
      {
        sandboxId: this.sandboxId,
        pid: this.pid,
        useLvm: this.paths?.useLvm,
      },
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
      await networkService.deleteTap(this.network.tapDevice);
      networkService.release(this.network.ipAddress);
    }

    await proxyService.removeRoutes(this.sandboxId);
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
