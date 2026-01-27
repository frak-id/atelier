import { $ } from "bun";
import type { SandboxPaths } from "../../infrastructure/firecracker/index.ts";
import type { NetworkAllocation } from "../../infrastructure/network/index.ts";
import { SecretsService } from "../../infrastructure/secrets/index.ts";
import type {
  FileSecret,
  GitHubSourceConfig,
  MergedConfigFile,
  RepoConfig,
  Workspace,
} from "../../schemas/index.ts";
import { config } from "../../shared/lib/config.ts";
import { createChildLogger } from "../../shared/lib/logger.ts";
import { ensureDir, injectFile } from "../../shared/lib/shell.ts";

const log = createChildLogger("sandbox-provisioner");

interface ProvisionContext {
  sandboxId: string;
  workspace?: Workspace;
  network: NetworkAllocation;
  paths: SandboxPaths;
  getGitSource: (id: string) => { type: string; config: unknown } | undefined;
  getConfigFiles: (workspaceId?: string) => MergedConfigFile[];
}

export const SandboxProvisioner = {
  async provision(ctx: ProvisionContext): Promise<void> {
    const mountPoint = `/tmp/rootfs-mount-${Date.now()}`;

    await ensureDir(mountPoint);

    const mountCmd = ctx.paths.useLvm
      ? `mount ${ctx.paths.overlay} ${mountPoint}`
      : `mount -o loop ${ctx.paths.overlay} ${mountPoint}`;

    if (!ctx.paths.useLvm) {
      await ensureDir(config.paths.OVERLAY_DIR);
      await $`cp ${ctx.paths.rootfs} ${ctx.paths.overlay}`.quiet();
    }

    await $`${{ raw: mountCmd }}`.quiet();

    try {
      await this.injectNetworkConfig(mountPoint, ctx.network);
      await this.injectSandboxConfig(mountPoint, ctx);
      await this.injectSecrets(mountPoint, ctx.workspace);
      await this.injectFileSecrets(mountPoint, ctx);
      await this.injectGitCredentials(mountPoint, ctx);
      await this.injectEditorConfigs(mountPoint, ctx);
      await this.injectSandboxMd(mountPoint, ctx);
    } finally {
      await $`umount ${mountPoint}`.quiet();
      await $`rmdir ${mountPoint}`.quiet();
    }

    log.debug({ sandboxId: ctx.sandboxId }, "Config injected");
  },

  async injectNetworkConfig(
    mountPoint: string,
    network: NetworkAllocation,
  ): Promise<void> {
    const dnsLines = config.network.dnsServers
      .map((dns) => `echo 'nameserver ${dns}' >> /etc/resolv.conf`)
      .join("\n");
    const networkScript = `#!/bin/bash
ip addr add 127.0.0.1/8 dev lo
ip link set lo up
ip addr add ${network.ipAddress}/24 dev eth0
ip link set eth0 up
ip route add default via ${network.gateway} dev eth0
> /etc/resolv.conf
${dnsLines}
`;
    await Bun.write(`${mountPoint}/etc/network-setup.sh`, networkScript);
    await $`chmod +x ${mountPoint}/etc/network-setup.sh`.quiet();
  },

  async injectSandboxConfig(
    mountPoint: string,
    ctx: ProvisionContext,
  ): Promise<void> {
    await ensureDir(`${mountPoint}/etc/sandbox/secrets`);

    const repos = ctx.workspace?.config.repos ?? [];
    const sandboxConfig = {
      sandboxId: ctx.sandboxId,
      workspaceId: ctx.workspace?.id,
      workspaceName: ctx.workspace?.name,
      repos,
      createdAt: new Date().toISOString(),
      network: {
        nfsHost: config.network.bridgeIp,
        dashboardDomain: config.domains.dashboard,
        managerInternalUrl: `http://${config.network.bridgeIp}:${config.raw.runtime.port}/internal`,
      },
      services: {
        vscode: { port: config.raw.services.vscode.port },
        opencode: { port: config.raw.services.opencode.port },
        terminal: { port: config.raw.services.terminal.port },
        agent: { port: config.raw.services.agent.port },
      },
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
  },

  async injectSecrets(
    mountPoint: string,
    workspace?: Workspace,
  ): Promise<void> {
    if (
      !workspace?.config.secrets ||
      Object.keys(workspace.config.secrets).length === 0
    ) {
      return;
    }

    const decryptedSecrets = await SecretsService.decryptSecrets(
      workspace.config.secrets,
    );
    const envFile = SecretsService.generateEnvFile(decryptedSecrets);
    await Bun.write(`${mountPoint}/etc/sandbox/secrets/.env`, envFile);
  },

  async injectFileSecrets(
    mountPoint: string,
    ctx: ProvisionContext,
  ): Promise<void> {
    const fileSecrets = ctx.workspace?.config.fileSecrets;
    if (!fileSecrets || fileSecrets.length === 0) return;

    for (const secret of fileSecrets) {
      const decryptedContent = await SecretsService.decrypt(secret.content);
      await injectFile({
        mountPoint,
        path: secret.path,
        content: decryptedContent,
        mode: secret.mode || "0600",
      });
    }

    log.debug(
      { sandboxId: ctx.sandboxId, fileSecretCount: fileSecrets.length },
      "File secrets injected",
    );
  },

  async injectGitCredentials(
    mountPoint: string,
    ctx: ProvisionContext,
  ): Promise<void> {
    const repos = ctx.workspace?.config.repos ?? [];
    const sourceIds = new Set<string>();

    for (const repo of repos) {
      if ("sourceId" in repo && repo.sourceId) {
        sourceIds.add(repo.sourceId);
      }
    }

    if (sourceIds.size === 0) return;

    const credentials: string[] = [];

    for (const sourceId of sourceIds) {
      const source = ctx.getGitSource(sourceId);
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
      { sandboxId: ctx.sandboxId, sourceCount: credentials.length },
      "Git credentials injected",
    );
  },

  async injectEditorConfigs(
    mountPoint: string,
    ctx: ProvisionContext,
  ): Promise<void> {
    const configs = ctx.getConfigFiles(ctx.workspace?.id);

    for (const configFile of configs) {
      await injectFile({
        mountPoint,
        path: configFile.path,
        content: configFile.content,
        contentType: configFile.contentType === "binary" ? "binary" : "text",
      });
    }

    await $`chown -R 1000:1000 ${mountPoint}/home/dev/.local`.quiet().nothrow();
    await $`chown -R 1000:1000 ${mountPoint}/home/dev/.config`
      .quiet()
      .nothrow();
    await $`chown -R 1000:1000 ${mountPoint}/etc/sandbox`.quiet().nothrow();

    log.debug(
      { sandboxId: ctx.sandboxId, configCount: configs.length },
      "Config files injected",
    );
  },

  async injectSandboxMd(
    mountPoint: string,
    ctx: ProvisionContext,
  ): Promise<void> {
    const sandboxMd = this.generateSandboxMd(ctx);
    await Bun.write(`${mountPoint}/home/dev/SANDBOX.md`, sandboxMd);
    await $`chown 1000:1000 ${mountPoint}/home/dev/SANDBOX.md`.quiet();
  },

  generateSandboxMd(ctx: ProvisionContext): string {
    const workspaceSection = ctx.workspace
      ? `## Workspace: ${ctx.workspace.name}

### Repositories
${ctx.workspace.config.repos.map((r) => `- ${this.getRepoDisplayName(r)}`).join("\n") || "No repositories configured"}
`
      : "";

    const fileSecretsSection = this.generateFileSecretsSection(
      ctx.workspace?.config.fileSecrets,
    );

    return `# Sandbox Environment: ${ctx.sandboxId}

${workspaceSection}## Available Services

| Service | URL | Port |
|---------|-----|------|
| VSCode Server | http://localhost:${config.raw.services.vscode.port} | ${config.raw.services.vscode.port} |
| OpenCode Server | http://localhost:${config.raw.services.opencode.port} | ${config.raw.services.opencode.port} |
| SSH | \`ssh dev@${ctx.network.ipAddress}\` | 22 |

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

## Secrets

### Environment Variables
Available in \`/etc/sandbox/secrets/.env\`
Source with: \`source /etc/sandbox/secrets/.env\`
${fileSecretsSection}
## Workspace

Your code is located in \`/home/dev/workspace\`

## Troubleshooting

- Services not responding? Check \`/var/log/sandbox/\`
- Network issues? Run \`ping ${config.network.bridgeIp}\`
- Need help? Check the project documentation
`;
  },

  generateFileSecretsSection(fileSecrets?: FileSecret[]): string {
    if (!fileSecrets || fileSecrets.length === 0) return "";

    const lines = fileSecrets.map(
      (s) => `| ${s.name} | \`${s.path.replace(/^~/, "/home/dev")}\` |`,
    );

    return `
### File Secrets
| Name | Path |
|------|------|
${lines.join("\n")}`;
  },

  getRepoDisplayName(repo: RepoConfig): string {
    if ("url" in repo) {
      return `${repo.url} (branch: ${repo.branch})`;
    }
    return `${repo.repo} (branch: ${repo.branch})`;
  },
};
