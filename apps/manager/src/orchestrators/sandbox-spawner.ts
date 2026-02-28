import { DEFAULTS } from "@frak/atelier-shared/constants";
import { customAlphabet } from "nanoid";
import type { AgentOperations } from "../infrastructure/agent/index.ts";
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
import type {
  CreateSandboxBody,
  CreateSandboxResponse,
  Sandbox,
  Workspace,
} from "../schemas/index.ts";
import { config, isMock } from "../shared/lib/config.ts";
import { safeNanoid } from "../shared/lib/id.ts";
import { createChildLogger } from "../shared/lib/logger.ts";
import { cleanupSandboxResources, waitForBoot } from "./kernel/index.ts";
import type { SandboxPorts } from "./ports/sandbox-ports.ts";
import {
  provisionSystemCreate,
  provisionWorkspaceCreate,
} from "./workflows/index.ts";

const log = createChildLogger("sandbox-spawner");

interface SandboxSpawnerDependencies {
  ports: SandboxPorts;
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

  constructor(
    private readonly deps: SandboxSpawnerDependencies,
    private readonly options: CreateSandboxBody,
  ) {
    this.sandboxId = safeNanoid();
    if (!options.system && !options.workspaceId) {
      throw new Error("workspaceId is required for workspace sandbox");
    }
  }

  async execute(): Promise<CreateSandboxResponse> {
    try {
      await this.loadWorkspace();
      await Promise.all([
        this.allocateNetwork(),
        this.createVolume(),
        isMock() ? Promise.resolve() : this.createTapDevice(),
      ]);
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
    if (this.options.workspaceId && !this.options.system) {
      this.workspace = this.deps.ports.workspaces.getById(
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
      (this.options.system ||
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

    this.deps.ports.sandbox.create(this.sandbox);
    log.info({ sandboxId: this.sandboxId }, "Sandbox initialized");
  }

  private async finalizeMock(): Promise<CreateSandboxResponse> {
    if (!this.sandbox) throw new Error("Sandbox not initialized");
    if (!this.network) throw new Error("Network not allocated");

    const sshCmd = await SshPiperService.registerRoute(
      this.sandboxId,
      this.network.ipAddress,
      this.deps.ports.sshKeys.getValidPublicKeys(),
    );

    this.sandbox.runtime.urls = {
      vscode: `https://sandbox-${this.sandboxId}.${config.domain.baseDomain}`,
      opencode: `https://opencode-${this.sandboxId}.${config.domain.baseDomain}`,
      ssh: sshCmd,
    };
    this.sandbox.status = "running";
    this.sandbox.runtime.pid = Math.floor(Math.random() * 100000);

    this.deps.ports.sandbox.update(this.sandboxId, this.sandbox);
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
      this.client ? waitForBoot(this.client) : Promise.resolve(),
      this.deps.ports.agent.waitForAgent(this.sandboxId, { timeout: 60000 }),
    ]);

    if (!agentReady) {
      log.warn({ sandboxId: this.sandboxId }, "Agent did not become ready");
    }

    log.debug({ sandboxId: this.sandboxId }, "VM booted and agent ready");
  }

  private async setupAgent(): Promise<void> {
    if (this.options.system) {
      await provisionSystemCreate(
        this.sandboxId,
        this.usedPrebuild,
        this.sandbox?.runtime.opencodePassword,
        this.deps.ports,
      );
      return;
    }

    if (!this.workspace) {
      throw new Error(
        "Workspace not loaded for workspace sandbox provisioning",
      );
    }

    await provisionWorkspaceCreate(
      this.sandboxId,
      this.workspace,
      this.usedPrebuild,
      this.sandbox?.runtime.opencodePassword,
      this.deps.ports,
    );
  }

  private async registerRoutes(): Promise<void> {
    if (!this.network) throw new Error("Network not allocated");
    if (!this.sandbox) throw new Error("Sandbox not initialized");

    const sshCmd = await SshPiperService.registerRoute(
      this.sandboxId,
      this.network.ipAddress,
      this.deps.ports.sshKeys.getValidPublicKeys(),
    );

    if (this.options.system) {
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

    this.deps.ports.sandbox.update(this.sandboxId, this.sandbox);
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

    await cleanupSandboxResources(this.sandboxId, {
      pid: this.pid,
      paths: this.paths,
      network: this.network,
    });

    try {
      this.deps.ports.sandbox.updateStatus(
        this.sandboxId,
        "error",
        "Build failed",
      );
    } catch {}
  }
}
