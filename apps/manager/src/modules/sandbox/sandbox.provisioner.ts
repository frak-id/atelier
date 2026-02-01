import type { SandboxConfig } from "@frak-sandbox/shared";
import { VM_PATHS } from "@frak-sandbox/shared/constants";
import { $ } from "bun";
import type { SandboxPaths } from "../../infrastructure/firecracker/index.ts";
import type { NetworkAllocation } from "../../infrastructure/network/index.ts";
import { RegistryService } from "../../infrastructure/registry/index.ts";
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
      await this.injectSharedBinariesPath(mountPoint);
      await this.injectRegistryConfig(mountPoint, ctx);
      await this.injectSandboxConfig(mountPoint, ctx);
      await this.injectSecrets(mountPoint, ctx.workspace);
      await this.injectFileSecrets(mountPoint, ctx);
      await this.injectGitCredentials(mountPoint, ctx);
      await this.injectEditorConfigs(mountPoint, ctx);
      await this.injectOhMyOpenCodeCache(mountPoint, ctx);
      await this.injectSandboxMd(mountPoint, ctx);
    } finally {
      await $`umount ${mountPoint}`.quiet();
      await $`rmdir ${mountPoint}`.quiet();
    }

    log.debug({ sandboxId: ctx.sandboxId }, "Config injected");
  },

  async injectSharedBinariesPath(mountPoint: string): Promise<void> {
    await ensureDir(`${mountPoint}/etc/profile.d`);
    await Bun.write(
      `${mountPoint}/etc/profile.d/shared-binaries.sh`,
      'export PATH="/opt/shared/bin:$PATH"\n',
    );
    await $`chmod +r ${mountPoint}/etc/profile.d/shared-binaries.sh`.quiet();
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

  async injectRegistryConfig(
    mountPoint: string,
    ctx: ProvisionContext,
  ): Promise<void> {
    const settings = RegistryService.getSettings();
    if (!settings.enabled) {
      log.debug("Registry disabled globally, skipping injection");
      return;
    }

    if (ctx.workspace?.config.useRegistryCache === false) {
      log.debug(
        { workspaceId: ctx.workspace.id },
        "Registry disabled for workspace, skipping injection",
      );
      return;
    }

    const registryUrl = RegistryService.getRegistryUrl();

    await Bun.write(
      `${mountPoint}/etc/profile.d/registry.sh`,
      `export NPM_CONFIG_REGISTRY="${registryUrl}"\n`,
    );
    await $`chmod +r ${mountPoint}/etc/profile.d/registry.sh`.quiet();

    await Bun.write(`${mountPoint}/etc/npmrc`, `registry=${registryUrl}\n`);

    const bunfigToml = `[install]\nregistry = "${registryUrl}"\n`;
    await Bun.write(`${mountPoint}/home/dev/.bunfig.toml`, bunfigToml);
    await $`chown 1000:1000 ${mountPoint}/home/dev/.bunfig.toml`.quiet();

    const yarnrcYml = `npmRegistryServer: "${registryUrl}"\nunsafeHttpWhitelist:\n  - "${config.network.bridgeIp}"\n`;
    await Bun.write(`${mountPoint}/home/dev/.yarnrc.yml`, yarnrcYml);
    await $`chown 1000:1000 ${mountPoint}/home/dev/.yarnrc.yml`.quiet();

    log.debug("Registry config injected");
  },

  async injectSandboxConfig(
    mountPoint: string,
    ctx: ProvisionContext,
  ): Promise<void> {
    await ensureDir(`${mountPoint}/etc/sandbox/secrets`);

    const repos = (ctx.workspace?.config.repos ?? []).map((r) => ({
      clonePath: r.clonePath,
      branch: r.branch,
    }));

    const workspaceDir =
      repos.length === 1 && repos[0]?.clonePath
        ? `/home/dev${repos[0].clonePath.startsWith("/workspace") ? repos[0].clonePath : `/workspace${repos[0].clonePath}`}`
        : "/home/dev/workspace";

    const dashboardDomain = config.domains.dashboard;
    const vsPort = config.raw.services.vscode.port;
    const ocPort = config.raw.services.opencode.port;
    const ttydPort = config.raw.services.terminal.port;
    const browserPort = config.raw.services.browser.port;

    const sandboxConfig = {
      sandboxId: ctx.sandboxId,
      workspaceId: ctx.workspace?.id,
      workspaceName: ctx.workspace?.name,
      repos,
      createdAt: new Date().toISOString(),
      network: {
        dashboardDomain,
        managerInternalUrl: `http://${config.network.bridgeIp}:${config.raw.runtime.port}/internal`,
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
          port: ttydPort,
          command: `ttyd -p ${ttydPort} -W -t fontSize=14 -t fontFamily=monospace su - dev`,
          user: "root" as const,
          autoStart: true,
        },
        browser: {
          port: browserPort,
        },
        xvfb: {
          command: "Xvfb :99 -screen 0 1280x900x24",
          user: "root" as const,
          autoStart: false,
        },
        chromium: {
          command:
            "chromium --no-sandbox --disable-gpu --disable-software-rasterizer --disable-dev-shm-usage --window-size=1280,900 --start-maximized about:blank",
          user: "dev" as const,
          autoStart: false,
          env: { DISPLAY: ":99" },
        },
        x11vnc: {
          command: "x11vnc -display :99 -forever -shared -nopw -rfbport 5900",
          user: "root" as const,
          autoStart: false,
        },
        websockify: {
          port: browserPort,
          command: `websockify --web /opt/novnc ${browserPort} localhost:5900`,
          user: "root" as const,
          autoStart: false,
        },
        agent: {
          port: config.raw.services.agent.port,
        },
      },
    } satisfies SandboxConfig;
    await Bun.write(
      `${mountPoint}/etc/sandbox/config.json`,
      JSON.stringify(sandboxConfig, null, 2),
    );
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

  /**
   * Seed oh-my-opencode's connected-providers cache to prevent a deadlock:
   * oh-my-opencode's config hook calls fetchAvailableModels() which requests
   * the /provider endpoint via the SDK client. But that endpoint is behind
   * the instance middleware that blocks until bootstrap completes — and
   * bootstrap is waiting for the config hook. Without the cache file,
   * fetchAvailableModels falls through to the API call, causing a circular wait.
   *
   * @see https://github.com/code-yeongyu/oh-my-opencode (configHandler in plugin init)
   */
  async injectOhMyOpenCodeCache(
    mountPoint: string,
    ctx: ProvisionContext,
  ): Promise<void> {
    const cacheDir = `${mountPoint}/home/dev/.cache/oh-my-opencode`;
    await ensureDir(cacheDir);

    const configs = ctx.getConfigFiles(ctx.workspace?.id);
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

    const connectedProviders = {
      connected: providers,
      updatedAt: new Date().toISOString(),
    };
    await Bun.write(
      `${cacheDir}/connected-providers.json`,
      JSON.stringify(connectedProviders, null, 2),
    );
    await $`chown -R 1000:1000 ${mountPoint}/home/dev/.cache/oh-my-opencode`.quiet();
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
