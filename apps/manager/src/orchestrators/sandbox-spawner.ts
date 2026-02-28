import { DEFAULTS, VM, VM_PATHS } from "@frak/atelier-shared/constants";
import { $ } from "bun";
import { customAlphabet } from "nanoid";
import type { AgentClient, FileWrite } from "../infrastructure/agent/index.ts";
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
import { SecretsService } from "../infrastructure/secrets/index.ts";
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
  GitHubSourceConfig,
  RepoConfig,
  Sandbox,
  Workspace,
} from "../schemas/index.ts";
import { config, isMock } from "../shared/lib/config.ts";
import { safeNanoid } from "../shared/lib/id.ts";
import { createChildLogger } from "../shared/lib/logger.ts";
import { killProcess } from "../shared/lib/shell.ts";
import { buildSandboxConfig, generateSandboxMd } from "./sandbox-config.ts";

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
  private isSystem: boolean;

  constructor(
    private readonly deps: SandboxSpawnerDependencies,
    private readonly options: CreateSandboxBody,
  ) {
    this.sandboxId = safeNanoid();
    this.isSystem = options.system ?? false;
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
    if (this.options.workspaceId && !this.isSystem) {
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
      (this.isSystem || this.workspace?.config.prebuild?.status === "ready")
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

  // ── Post-boot provisioning (batched) ──────────────────────────────

  private async setupAgent(): Promise<void> {
    if (!this.network) throw new Error("Network not allocated");

    // Phase 0: Push sandbox config (agent reads this for service definitions)
    const sandboxConfig = buildSandboxConfig(
      this.sandboxId,
      this.workspace,
      this.sandbox?.runtime.opencodePassword,
    );
    await this.deps.provisionService.pushSandboxConfig(
      this.sandboxId,
      sandboxConfig,
    );

    // Phase 1+2: Collect all files & commands, flush in 2 vsock calls
    const { files, commands } = await this.collectProvisionBatch();

    if (files.length > 0) {
      await this.deps.agentClient.writeFiles(this.sandboxId, files);
      log.debug(
        { sandboxId: this.sandboxId, fileCount: files.length },
        "Provision files written",
      );
    }

    if (commands.length > 0) {
      const batchResult = await this.deps.agentClient.batchExec(
        this.sandboxId,
        commands,
        { timeout: 90000 },
      );
      for (const r of batchResult.results) {
        if (r.exitCode !== 0) {
          log.warn(
            { sandboxId: this.sandboxId, command: r.id, stderr: r.stderr },
            "Batch command failed (non-blocking)",
          );
        }
      }
    }

    // Phase 3: Clone repositories (needs DNS + creds + expanded FS)
    if (
      !this.isSystem &&
      !this.usedPrebuild &&
      this.workspace?.config.repos?.length
    ) {
      for (const repo of this.workspace.config.repos) {
        await this.cloneRepository(repo);
      }
    }

    // Phase 4: Start services
    const serviceNames = this.isSystem ? ["opencode"] : ["vscode", "opencode"];
    await this.deps.provisionService.startServices(
      this.sandboxId,
      serviceNames,
    );
    log.info({ sandboxId: this.sandboxId }, "Post-boot services started");
  }

  /**
   * Collect every file and command needed for post-boot provisioning.
   *
   * Dependency ordering:
   *   Phase 1 (files): DNS (resolv.conf), git creds, env, secrets, configs
   *   Phase 2 (commands): hostname, chronyd, resize2fs+swap
   *   Files are flushed before commands, so chronyd gets DNS and swap
   *   gets an expanded FS when resize2fs is chained.
   */
  private async collectProvisionBatch(): Promise<{
    files: FileWrite[];
    commands: { id: string; command: string; timeout?: number }[];
  }> {
    const ps = this.deps.provisionService;
    const files: FileWrite[] = [];
    const commands: { id: string; command: string; timeout?: number }[] = [];

    // ── Files ────────────────────────────────────────────────────────

    // DNS (resolv.conf) — enables name resolution for chronyd + git clone
    files.push(...ps.collectDnsFiles());

    // Hostname
    files.push(ps.collectHostnameFile(`sandbox-${this.sandboxId}`));

    // Runtime environment
    files.push(
      ...ps.collectRuntimeEnvFiles({
        ATELIER_SANDBOX_ID: this.sandboxId,
      }),
    );

    if (!this.isSystem) {
      // Secrets
      const secrets = this.workspace?.config.secrets;
      if (secrets && Object.keys(secrets).length > 0) {
        const decrypted = await SecretsService.decryptSecrets(secrets);
        const envFile = SecretsService.generateEnvFile(decrypted);
        files.push(...ps.collectSecretsFiles(envFile));
      }

      // Git credentials
      const credentials = this.collectGitCredentials();
      files.push(...ps.collectGitConfigFiles(credentials));

      // File secrets
      const fileSecrets = this.workspace?.config.fileSecrets;
      if (fileSecrets?.length) {
        const decrypted = await SecretsService.decryptFileSecrets(fileSecrets);
        files.push(
          ...ps.collectFileSecretsFiles(
            decrypted.map((s) => ({
              path: s.path,
              content: s.content,
              mode: s.mode,
            })),
          ),
        );
      }

      // OhMyOpenCode provider cache
      const providers = this.collectOhMyOpenCodeProviders();
      files.push(...ps.collectOhMyOpenCodeCacheFiles(providers));

      // SANDBOX.md
      const sandboxMd = generateSandboxMd(this.sandboxId, this.workspace);
      files.push(ps.collectSandboxMdFile(sandboxMd));
    }

    // Auth + configs (applies to all sandboxes)
    files.push(
      ...this.deps.internalService.collectSyncFiles(this.workspace?.id),
    );

    // Registry config
    files.push(...ps.collectRegistryConfigFiles());

    // ── Commands (run in parallel via batchExec) ─────────────────────

    // Hostname (kernel — file already written above)
    commands.push({
      id: "hostname",
      command: `hostname "sandbox-${this.sandboxId}"`,
    });

    // Clock sync (needs DNS from resolv.conf written in files phase)
    commands.push({
      id: "clock",
      command:
        "pkill chronyd 2>/dev/null; chronyd -f /etc/chrony/chrony.conf 2>/dev/null || true",
      timeout: 5000,
    });

    // Filesystem expand + swap (chained so swap gets expanded disk)
    if (this.paths?.useLvm) {
      if (!this.usedPrebuild) {
        const expandAndSwap = [
          "test -e /dev/vda || mknod /dev/vda b 254 0",
          "resize2fs /dev/vda",
        ];
        if (!this.isSystem) {
          expandAndSwap.push("/etc/sandbox/setup-swap.sh");
        }
        commands.push({
          id: "expand-and-swap",
          command: expandAndSwap.join(" && "),
          timeout: 60000,
        });
      } else if (!this.isSystem) {
        // Prebuild: FS already expanded, just reactivate swap
        commands.push({
          id: "swap",
          command: "/etc/sandbox/setup-swap.sh",
          timeout: 30000,
        });
      }
    }

    return { files, commands };
  }

  private collectGitCredentials(): string[] {
    const sources = this.deps.gitSourceService.getAll();
    const credentials: string[] = [];

    for (const source of sources) {
      if (source.type === "github") {
        const ghConfig = source.config as GitHubSourceConfig;
        if (ghConfig.accessToken) {
          credentials.push(
            `https://x-access-token:${ghConfig.accessToken}@github.com`,
          );
        }
      }
    }

    return credentials;
  }

  private collectOhMyOpenCodeProviders(): string[] {
    const configs = this.deps.configFileService.getMergedForSandbox(
      this.workspace?.id,
    );
    const authConfig = configs.find((c) => c.path === VM_PATHS.opencodeAuth);
    if (!authConfig) return [];

    try {
      const authJson = JSON.parse(authConfig.content);
      return Object.keys(authJson);
    } catch {
      log.warn("Failed to parse auth.json for oh-my-opencode cache seed");
      return [];
    }
  }

  // ── Git clone ─────────────────────────────────────────────────────

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

    // Single exec: rm + clone + chown (as root)
    const result = await this.deps.agentClient.exec(
      this.sandboxId,
      [
        `rm -rf ${clonePath}`,
        `git clone --depth 1 -b ${branch} ${gitUrl} ${clonePath}`,
        `chown -R dev:dev ${clonePath}`,
      ].join(" && "),
      { timeout: 120000 },
    );

    if (result.exitCode !== 0) {
      log.error(
        { sandboxId: this.sandboxId, stderr: result.stderr },
        "Git clone failed",
      );
      throw new Error(`Git clone failed: ${result.stderr}`);
    }

    // Safe directory config (must run as dev user)
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

  // ── Routes + finalize ─────────────────────────────────────────────

  private async registerRoutes(): Promise<void> {
    if (!this.network) throw new Error("Network not allocated");
    if (!this.sandbox) throw new Error("Sandbox not initialized");

    // System sandboxes only get SSH (no Caddy web routes)
    const sshCmd = await SshPiperService.registerRoute(
      this.sandboxId,
      this.network.ipAddress,
      this.deps.sshKeyService.getValidPublicKeys(),
    );

    if (this.isSystem) {
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
