import { FIRECRACKER } from "@frak-sandbox/shared/constants";
import { $ } from "bun";
import { nanoid } from "nanoid";
import { config } from "../lib/config.ts";
import { createChildLogger } from "../lib/logger.ts";
import { ensureDir } from "../lib/shell.ts";
import type {
  CreateSandboxBody,
  GitHubSourceConfig,
  RepoConfig,
  Sandbox,
  Workspace,
} from "../schemas/index.ts";
import {
  GitSourceRepository,
  SandboxRepository,
  WorkspaceRepository,
} from "../state/database.ts";
import { AgentClient } from "./agent.ts";
import { CaddyService } from "./caddy.ts";
import { ConfigFilesService } from "./config-files.ts";
import { FirecrackerClient } from "./firecracker-client.ts";
import { type NetworkAllocation, NetworkService } from "./network.ts";
import { SecretsService } from "./secrets.ts";
import { StorageService } from "./storage.ts";

const log = createChildLogger("sandbox-builder");

const VSCODE_PORT = 8080;
const OPENCODE_PORT = 3000;
const TERMINAL_PORT = 7681;

interface SandboxPaths {
  socket: string;
  pid: string;
  log: string;
  overlay: string;
  kernel: string;
  rootfs: string;
  useLvm: boolean;
}

function getSandboxPaths(
  sandboxId: string,
  lvmVolumePath?: string,
): SandboxPaths {
  return {
    socket: `${config.paths.SOCKET_DIR}/${sandboxId}.sock`,
    pid: `${config.paths.SOCKET_DIR}/${sandboxId}.pid`,
    log: `${config.paths.LOG_DIR}/${sandboxId}.log`,
    overlay: lvmVolumePath || `${config.paths.OVERLAY_DIR}/${sandboxId}.ext4`,
    kernel: `${config.paths.KERNEL_DIR}/vmlinux`,
    rootfs: `${config.paths.ROOTFS_DIR}/rootfs.ext4`,
    useLvm: !!lvmVolumePath,
  };
}

export class SandboxBuilder {
  private sandboxId: string;
  private options: CreateSandboxBody;
  private workspace?: Workspace;
  private sandbox?: Sandbox;
  private network?: NetworkAllocation;
  private paths?: SandboxPaths;
  private pid?: number;
  private client?: FirecrackerClient;
  private usedPrebuild = false;

  private constructor(options: CreateSandboxBody) {
    this.sandboxId = nanoid(12);
    this.options = options;
  }

  static create(options: CreateSandboxBody = {}): SandboxBuilder {
    return new SandboxBuilder(options);
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
      await this.injectConfig();
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
      this.workspace = WorkspaceRepository.getById(this.options.workspaceId);
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
    if (!this.paths) {
      throw new Error("Sandbox paths not initialized");
    }
    if (!this.network) {
      throw new Error("Network not allocated");
    }

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

    SandboxRepository.create(this.sandbox);
    log.info({ sandboxId: this.sandboxId }, "Sandbox initialized");
  }

  private finalizeMock(): Sandbox {
    if (!this.sandbox) {
      throw new Error("Sandbox not initialized");
    }

    this.sandbox.runtime.urls = {
      vscode: `https://sandbox-${this.sandboxId}.${config.caddy.domainSuffix}`,
      opencode: `https://opencode-${this.sandboxId}.${config.caddy.domainSuffix}`,
      terminal: `https://terminal-${this.sandboxId}.${config.caddy.domainSuffix}`,
      ssh: `ssh root@${this.network?.ipAddress}`,
    };
    this.sandbox.status = "running";
    this.sandbox.runtime.pid = Math.floor(Math.random() * 100000);

    SandboxRepository.update(this.sandboxId, this.sandbox);
    log.info({ sandboxId: this.sandboxId }, "Mock sandbox created");
    return this.sandbox;
  }

  private async createTapDevice(): Promise<void> {
    if (!this.network) {
      throw new Error("Network not allocated");
    }
    await NetworkService.createTap(this.network.tapDevice);
  }

  private async injectConfig(): Promise<void> {
    const mountPoint = `/tmp/rootfs-mount-${Date.now()}`;

    await ensureDir(mountPoint);

    const mountCmd = this.paths?.useLvm
      ? `mount ${this.paths?.overlay} ${mountPoint}`
      : `mount -o loop ${this.paths?.overlay} ${mountPoint}`;

    if (!this.paths?.useLvm) {
      await ensureDir(config.paths.OVERLAY_DIR);
      await $`cp ${this.paths?.rootfs} ${this.paths?.overlay}`.quiet();
    }

    await $`${{ raw: mountCmd }}`.quiet();

    try {
      const networkScript = `#!/bin/bash
ip addr add ${this.network?.ipAddress}/24 dev eth0
ip link set eth0 up
ip route add default via ${this.network?.gateway} dev eth0
echo 'nameserver 8.8.8.8' > /etc/resolv.conf
`;
      await Bun.write(`${mountPoint}/etc/network-setup.sh`, networkScript);
      await $`chmod +x ${mountPoint}/etc/network-setup.sh`.quiet();

      await ensureDir(`${mountPoint}/etc/sandbox/secrets`);

      const repos = this.workspace?.config.repos ?? [];
      const sandboxConfig = {
        sandboxId: this.sandboxId,
        workspaceId: this.workspace?.id,
        workspaceName: this.workspace?.name,
        repos,
        createdAt: new Date().toISOString(),
      };
      await Bun.write(
        `${mountPoint}/etc/sandbox/config.json`,
        JSON.stringify(sandboxConfig, null, 2),
      );

      const workspaceDir =
        repos.length === 1 && repos[0]?.clonePath
          ? `/home/dev${repos[0].clonePath.startsWith("/workspace") ? repos[0].clonePath : `/workspace${repos[0].clonePath}`}`
          : "/home/dev/workspace";
      await Bun.write(`${mountPoint}/etc/sandbox/workspace-dir`, workspaceDir);

      if (
        this.workspace?.config.secrets &&
        Object.keys(this.workspace.config.secrets).length > 0
      ) {
        const decryptedSecrets = await SecretsService.decryptSecrets(
          this.workspace.config.secrets,
        );
        const envFile = SecretsService.generateEnvFile(decryptedSecrets);
        await Bun.write(`${mountPoint}/etc/sandbox/secrets/.env`, envFile);
      }

      await this.injectGitCredentials(mountPoint);

      if (
        this.workspace?.config.startCommands &&
        this.workspace.config.startCommands.length > 0
      ) {
        const startScript = `#!/bin/bash\nset -e\n${this.workspace.config.startCommands.join("\n")}\n`;
        await Bun.write(`${mountPoint}/etc/sandbox/start.sh`, startScript);
        await $`chmod +x ${mountPoint}/etc/sandbox/start.sh`.quiet();
      }

      await this.injectEditorConfigs(mountPoint);

      const sandboxMd = this.generateSandboxMd();
      await Bun.write(`${mountPoint}/home/dev/SANDBOX.md`, sandboxMd);
      await $`chown 1000:1000 ${mountPoint}/home/dev/SANDBOX.md`.quiet();
    } finally {
      await $`umount ${mountPoint}`.quiet();
      await $`rmdir ${mountPoint}`.quiet();
    }

    log.debug({ sandboxId: this.sandboxId }, "Config injected");
  }

  private async injectEditorConfigs(mountPoint: string): Promise<void> {
    const configs = ConfigFilesService.getMergedForSandbox(this.workspace?.id);

    for (const configFile of configs) {
      const targetPath = configFile.path.replace(/^~/, "/home/dev");
      const fullPath = `${mountPoint}${targetPath}`;
      const dir = fullPath.substring(0, fullPath.lastIndexOf("/"));

      await ensureDir(dir);

      if (configFile.contentType === "binary") {
        const buffer = Buffer.from(configFile.content, "base64");
        await Bun.write(fullPath, buffer);
      } else {
        await Bun.write(fullPath, configFile.content);
      }
    }

    await $`chown -R 1000:1000 ${mountPoint}/home/dev/.local`.quiet().nothrow();
    await $`chown -R 1000:1000 ${mountPoint}/home/dev/.config`
      .quiet()
      .nothrow();
    await $`chown -R 1000:1000 ${mountPoint}/etc/sandbox`.quiet().nothrow();

    log.debug(
      { sandboxId: this.sandboxId, configCount: configs.length },
      "Config files injected",
    );
  }

  private async injectGitCredentials(mountPoint: string): Promise<void> {
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
      const source = GitSourceRepository.getById(sourceId);
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

    if (credentials.length === 0) return;

    await Bun.write(
      `${mountPoint}/etc/sandbox/secrets/git-credentials`,
      `${credentials.join("\n")}\n`,
    );
    await $`chmod 600 ${mountPoint}/etc/sandbox/secrets/git-credentials`.quiet();

    const gitconfig = `[credential]
\thelper = store --file=/etc/sandbox/secrets/git-credentials
[user]
\temail = sandbox@frak.dev
\tname = Sandbox User
`;
    await Bun.write(`${mountPoint}/home/dev/.gitconfig`, gitconfig);
    await $`chown 1000:1000 ${mountPoint}/home/dev/.gitconfig`.quiet();

    log.debug(
      { sandboxId: this.sandboxId, sourceCount: credentials.length },
      "Git credentials injected",
    );
  }

  private generateSandboxMd(): string {
    const workspaceSection = this.workspace
      ? `## Workspace: ${this.workspace.name}

### Repositories
${this.workspace.config.repos.map((r) => `- ${this.getRepoDisplayName(r)}`).join("\n") || "No repositories configured"}
`
      : "";

    return `# Sandbox Environment: ${this.sandboxId}

${workspaceSection}## Available Services

| Service | URL | Port |
|---------|-----|------|
| VSCode Server | http://localhost:8080 | 8080 |
| OpenCode Server | http://localhost:3000 | 3000 |
| SSH | \`ssh dev@${this.network?.ipAddress}\` | 22 |

## Quick Commands

\`\`\`bash
# Check sandbox status
cat /etc/sandbox/config.json

# View service logs
tail -f /var/log/sandbox/code-server.log
tail -f /var/log/sandbox/opencode.log

# Restart services
sudo systemctl restart code-server
sudo systemctl restart opencode
\`\`\`

## Environment Variables

Secrets are available in \`/etc/sandbox/secrets/.env\`
Source with: \`source /etc/sandbox/secrets/.env\`

## Workspace

Your code is located in \`/home/dev/workspace\`

## Troubleshooting

- Services not responding? Check \`/var/log/sandbox/\`
- Network issues? Run \`ping 172.16.0.1\`
- Need help? Check the project documentation
`;
  }

  private getRepoDisplayName(repo: RepoConfig): string {
    if ("url" in repo) {
      return `${repo.url} (branch: ${repo.branch})`;
    }
    return `${repo.repo} (branch: ${repo.branch})`;
  }

  private async launchFirecracker(): Promise<void> {
    if (!this.paths) {
      throw new Error("Sandbox paths not initialized");
    }

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
    const agentReady = await AgentClient.waitForAgent(this.sandboxId, {
      timeout: 60000,
    });

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
    if (
      !this.workspace?.config.repos ||
      this.workspace.config.repos.length === 0
    ) {
      return;
    }

    for (const repo of this.workspace.config.repos) {
      await this.cloneRepository(repo);
    }
  }

  private async cloneRepository(repo: RepoConfig): Promise<void> {
    const clonePath = `/home/dev/workspace/${repo.clonePath}`;
    const gitUrl = "url" in repo ? repo.url : await this.resolveSourceUrl(repo);
    const branch = repo.branch;

    log.info(
      { sandboxId: this.sandboxId, gitUrl, branch, clonePath },
      "Cloning repository in sandbox",
    );

    await AgentClient.exec(this.sandboxId, `rm -rf ${clonePath}`);

    const result = await AgentClient.exec(
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

    await AgentClient.exec(this.sandboxId, `chown -R dev:dev ${clonePath}`);
    await AgentClient.exec(
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
    const source = GitSourceRepository.getById(repo.sourceId);
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
    if (!this.network) {
      throw new Error("Network not allocated");
    }
    if (!this.sandbox) {
      throw new Error("Sandbox not initialized");
    }

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
    if (!this.sandbox) {
      throw new Error("Sandbox not initialized");
    }
    this.sandbox.status = "running";
    this.sandbox.runtime.pid = this.pid;

    SandboxRepository.update(this.sandboxId, this.sandbox);
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
      SandboxRepository.updateStatus(this.sandboxId, "error", "Build failed");
    } catch {}
  }
}
