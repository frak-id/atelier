import { nanoid } from "nanoid";
import type { Sandbox, CreateSandboxOptions, Project } from "@frak-sandbox/shared/types";
import { FIRECRACKER } from "@frak-sandbox/shared/constants";
import { exec, fileExists, readFile } from "../lib/shell.ts";
import { config } from "../lib/config.ts";
import { createChildLogger } from "../lib/logger.ts";
import { sandboxStore } from "../state/store.ts";
import { projectStore } from "../state/project-store.ts";
import { NetworkService } from "./network.ts";
import { CaddyService } from "./caddy.ts";
import { StorageService } from "./storage.ts";
import { QueueService } from "./queue.ts";
import { SecretsService } from "./secrets.ts";

const log = createChildLogger("firecracker");

const VSCODE_PORT = 8080;
const OPENCODE_PORT = 3000;

let lvmAvailable: boolean | null = null;

function getSandboxPaths(sandboxId: string, lvmVolumePath?: string) {
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

export const FirecrackerService = {
  async spawn(options: CreateSandboxOptions = {}): Promise<Sandbox> {
    const sandboxId = options.id || nanoid(12);

    let project: Project | undefined;
    if (options.projectId) {
      project = projectStore.getById(options.projectId);
    }

    // Priority: explicit option > project config > default
    const baseImage = options.baseImage ?? project?.baseImage;

    if (lvmAvailable === null) {
      lvmAvailable = await StorageService.isAvailable();
      log.info({ lvmAvailable }, "LVM availability checked");
    }

    let lvmVolumePath: string | undefined;
    if (lvmAvailable) {
      lvmVolumePath = await StorageService.createSandboxVolume(sandboxId, {
        projectId: options.projectId,
        baseImage,
      });
    }

    const paths = getSandboxPaths(sandboxId, lvmVolumePath);
    log.info({ sandboxId, options, baseImage, useLvm: paths.useLvm }, "Spawning sandbox");

    const vcpus = options.vcpus ?? project?.vcpus ?? config.defaults.VCPUS;
    const memoryMb = options.memoryMb ?? project?.memoryMb ?? config.defaults.MEMORY_MB;

    const sandbox: Sandbox = {
      id: sandboxId,
      status: "creating",
      projectId: options.projectId,
      branch: options.branch ?? project?.defaultBranch,
      ipAddress: "",
      macAddress: "",
      urls: { vscode: "", opencode: "", ssh: "" },
      resources: { vcpus, memoryMb },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    sandboxStore.create(sandbox);

    try {
      const network = await NetworkService.allocate(sandboxId);
      sandbox.ipAddress = network.ipAddress;
      sandbox.macAddress = network.macAddress;

      if (config.isMock()) {
        sandbox.urls = {
          vscode: `https://sandbox-${sandboxId}.${config.caddy.domainSuffix}`,
          opencode: `https://opencode-${sandboxId}.${config.caddy.domainSuffix}`,
          ssh: `ssh root@${network.ipAddress}`,
        };
        sandbox.status = "running";
        sandbox.pid = Math.floor(Math.random() * 100000);
        sandboxStore.update(sandboxId, sandbox);

        log.info({ sandboxId }, "Mock sandbox spawned");
        return sandbox;
      }

      await NetworkService.createTap(network.tapDevice);

      if (!paths.useLvm) {
        await this.createOverlay(sandboxId, paths);
      }
      await this.injectSandboxConfig(paths.overlay, sandboxId, network, project);

      const pid = await this.startFirecracker(sandboxId, paths);
      sandbox.pid = pid;

      await this.configureVm(sandboxId, paths, network, sandbox.resources);
      await this.bootVm(sandboxId, paths);

      const urls = await CaddyService.registerRoutes(sandboxId, network.ipAddress, {
        vscode: VSCODE_PORT,
        opencode: OPENCODE_PORT,
      });

      sandbox.urls = {
        ...urls,
        ssh: `ssh root@${network.ipAddress}`,
      };
      sandbox.status = "running";

      sandboxStore.update(sandboxId, sandbox);
      log.info({ sandboxId, pid, useLvm: paths.useLvm }, "Sandbox spawned successfully");

      return sandbox;
    } catch (error) {
      log.error({ sandboxId, error }, "Failed to spawn sandbox");

      if (lvmAvailable) {
        await StorageService.deleteSandboxVolume(sandboxId).catch(() => {});
      }

      sandboxStore.updateStatus(
        sandboxId,
        "error",
        error instanceof Error ? error.message : String(error)
      );
      throw error;
    }
  },

  async destroy(sandboxId: string): Promise<void> {
    const sandbox = sandboxStore.getById(sandboxId);
    if (!sandbox) {
      throw new Error(`Sandbox '${sandboxId}' not found`);
    }

    log.info({ sandboxId }, "Destroying sandbox");

    const paths = getSandboxPaths(sandboxId);

    if (!config.isMock()) {
      if (sandbox.pid) {
        await exec(`kill ${sandbox.pid} 2>/dev/null || true`);
        await Bun.sleep(500);
        await exec(`kill -9 ${sandbox.pid} 2>/dev/null || true`);
      }

      await exec(`rm -f ${paths.socket} ${paths.pid}`);

      if (lvmAvailable) {
        await StorageService.deleteSandboxVolume(sandboxId);
      } else {
        await exec(`rm -f ${paths.overlay}`);
      }

      const tapDevice = `tap-${sandboxId.slice(0, 8)}`;
      await NetworkService.deleteTap(tapDevice);

      NetworkService.release(sandbox.ipAddress);
      await CaddyService.removeRoutes(sandboxId);
    }

    sandboxStore.delete(sandboxId);
    log.info({ sandboxId }, "Sandbox destroyed");
  },

  async getStatus(sandboxId: string): Promise<Sandbox> {
    const sandbox = sandboxStore.getById(sandboxId);
    if (!sandbox) {
      throw new Error(`Sandbox '${sandboxId}' not found`);
    }

    if (config.isMock() || !sandbox.pid) {
      return sandbox;
    }

    const paths = getSandboxPaths(sandboxId);
    const processAlive = await exec(`kill -0 ${sandbox.pid}`, { throws: false });
    const socketExists = await fileExists(paths.socket);

    if (!processAlive.success || !socketExists) {
      sandboxStore.updateStatus(sandboxId, "stopped");
    }

    return sandboxStore.getById(sandboxId)!;
  },

  async createOverlay(sandboxId: string, paths: ReturnType<typeof getSandboxPaths>): Promise<void> {
    await exec(`mkdir -p ${config.paths.OVERLAY_DIR}`);
    await exec(`cp ${paths.rootfs} ${paths.overlay}`);
    log.debug({ sandboxId }, "Overlay created");
  },

  async injectSandboxConfig(
    overlayPath: string,
    sandboxId: string,
    network: { ipAddress: string; gateway: string },
    project?: Project
  ): Promise<void> {
    const mountPoint = `/tmp/rootfs-mount-${Date.now()}`;

    await exec(`mkdir -p ${mountPoint}`);
    await exec(`mount -o loop ${overlayPath} ${mountPoint}`);

    try {
      const networkScript = `#!/bin/bash
ip addr add ${network.ipAddress}/24 dev eth0
ip link set eth0 up
ip route add default via ${network.gateway} dev eth0
echo 'nameserver 8.8.8.8' > /etc/resolv.conf
`;
      await Bun.write(`${mountPoint}/etc/network-setup.sh`, networkScript);
      await exec(`chmod +x ${mountPoint}/etc/network-setup.sh`);

      await exec(`mkdir -p ${mountPoint}/etc/sandbox/secrets`);

      const sandboxConfig = {
        sandboxId,
        projectId: project?.id,
        projectName: project?.name,
        gitUrl: project?.gitUrl,
        createdAt: new Date().toISOString(),
      };
      await Bun.write(`${mountPoint}/etc/sandbox/config.json`, JSON.stringify(sandboxConfig, null, 2));

      if (project?.secrets && Object.keys(project.secrets).length > 0) {
        const decryptedSecrets = await SecretsService.decryptSecrets(project.secrets);
        const envFile = SecretsService.generateEnvFile(decryptedSecrets);
        await Bun.write(`${mountPoint}/etc/sandbox/secrets/.env`, envFile);
      }

      if (project?.startCommands && project.startCommands.length > 0) {
        const startScript = `#!/bin/bash\nset -e\n${project.startCommands.join("\n")}\n`;
        await Bun.write(`${mountPoint}/etc/sandbox/start.sh`, startScript);
        await exec(`chmod +x ${mountPoint}/etc/sandbox/start.sh`);
      }

      const sandboxMd = this.generateSandboxMd(sandboxId, network.ipAddress, project);
      await Bun.write(`${mountPoint}/home/dev/SANDBOX.md`, sandboxMd);
      await exec(`chown 1000:1000 ${mountPoint}/home/dev/SANDBOX.md`);
    } finally {
      await exec(`umount ${mountPoint}`);
      await exec(`rmdir ${mountPoint}`);
    }

    log.debug({ overlayPath, sandboxId }, "Sandbox config injected");
  },

  generateSandboxMd(sandboxId: string, ipAddress: string, project?: Project): string {
    const projectSection = project
      ? `## Project: ${project.name}
- **Repository**: ${project.gitUrl}
- **Branch**: ${project.defaultBranch}
`
      : "";

    return `# Sandbox Environment: ${sandboxId}

${projectSection}## Available Services

| Service | URL | Port |
|---------|-----|------|
| VSCode Server | http://localhost:8080 | 8080 |
| OpenCode Server | http://localhost:3000 | 3000 |
| SSH | \`ssh dev@${ipAddress}\` | 22 |

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
  },

  async startFirecracker(
    sandboxId: string,
    paths: ReturnType<typeof getSandboxPaths>
  ): Promise<number> {
    await exec(`mkdir -p ${config.paths.SOCKET_DIR} ${config.paths.LOG_DIR}`);
    await exec(`rm -f ${paths.socket}`);
    // Firecracker requires log file to exist before startup
    await exec(`touch ${paths.log}`);

    const proc = Bun.spawn(
      [
        FIRECRACKER.BINARY_PATH,
        "--api-sock",
        paths.socket,
        "--log-path",
        paths.log,
        "--level",
        "Warning",
      ],
      {
        stdout: "ignore",
        stderr: "ignore",
        stdin: "ignore",
      }
    );

    await Bun.write(paths.pid, String(proc.pid));
    await Bun.sleep(500);

    const alive = await exec(`kill -0 ${proc.pid}`, { throws: false });
    if (!alive.success) {
      const logContent = await readFile(paths.log);
      log.error({ sandboxId, log: logContent }, "Firecracker failed to start");
      throw new Error("Firecracker process died on startup");
    }

    log.debug({ sandboxId, pid: proc.pid }, "Firecracker process started");
    return proc.pid;
  },

  async configureVm(
    sandboxId: string,
    paths: ReturnType<typeof getSandboxPaths>,
    network: { macAddress: string; tapDevice: string },
    resources: { vcpus: number; memoryMb: number }
  ): Promise<void> {
    const curlBase = `curl -s --unix-socket ${paths.socket}`;
    const bootArgs = "console=ttyS0 reboot=k panic=1 pci=off";

    await exec(`${curlBase} -X PUT "http://localhost/boot-source" \
      -H "Content-Type: application/json" \
      -d '{"kernel_image_path": "${paths.kernel}", "boot_args": "${bootArgs}"}'`);

    await exec(`${curlBase} -X PUT "http://localhost/drives/rootfs" \
      -H "Content-Type: application/json" \
      -d '{"drive_id": "rootfs", "path_on_host": "${paths.overlay}", "is_root_device": true, "is_read_only": false}'`);

    await exec(`${curlBase} -X PUT "http://localhost/network-interfaces/eth0" \
      -H "Content-Type: application/json" \
      -d '{"iface_id": "eth0", "guest_mac": "${network.macAddress}", "host_dev_name": "${network.tapDevice}"}'`);

    await exec(`${curlBase} -X PUT "http://localhost/machine-config" \
      -H "Content-Type: application/json" \
      -d '{"vcpu_count": ${resources.vcpus}, "mem_size_mib": ${resources.memoryMb}}'`);

    await Bun.sleep(100);
    log.debug({ sandboxId }, "VM configured");
  },

  async bootVm(sandboxId: string, paths: ReturnType<typeof getSandboxPaths>): Promise<void> {
    await exec(
      `curl -s --unix-socket ${paths.socket} -X PUT "http://localhost/actions" \
        -H "Content-Type: application/json" \
        -d '{"action_type": "InstanceStart"}'`
    );

    await Bun.sleep(2000);
    log.debug({ sandboxId }, "VM booted");
  },

  async getFirecrackerState(sandboxId: string): Promise<unknown> {
    const paths = getSandboxPaths(sandboxId);

    if (config.isMock()) {
      return { mock: true, sandboxId };
    }

    if (!(await fileExists(paths.socket))) {
      return { error: "Socket not found", sandboxId };
    }

    const result = await exec(
      `curl -s --unix-socket ${paths.socket} "http://localhost/"`,
      { throws: false }
    );

    if (!result.success) {
      return { error: "Failed to query Firecracker", sandboxId };
    }

    try {
      return JSON.parse(result.stdout);
    } catch {
      return { raw: result.stdout };
    }
  },

  async isHealthy(): Promise<boolean> {
    if (config.isMock()) {
      return true;
    }

    const exists = await fileExists(FIRECRACKER.BINARY_PATH);
    if (!exists) return false;

    const kvmOk = await exec("test -r /dev/kvm && test -w /dev/kvm", { throws: false });
    return kvmOk.success;
  },

  isLvmEnabled(): boolean {
    return lvmAvailable === true;
  },

  async checkLvmAvailability(): Promise<boolean> {
    lvmAvailable = await StorageService.isAvailable();
    return lvmAvailable;
  },
};

QueueService.setHandler((options) => FirecrackerService.spawn(options));
