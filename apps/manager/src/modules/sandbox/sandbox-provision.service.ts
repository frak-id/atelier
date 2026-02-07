import type { SandboxConfig } from "@frak/atelier-shared";
import { VM } from "@frak/atelier-shared/constants";
import type { AgentClient } from "../../infrastructure/agent/agent.client.ts";
import { RegistryService } from "../../infrastructure/registry/index.ts";
import { config } from "../../shared/lib/config.ts";
import { createChildLogger } from "../../shared/lib/logger.ts";

const log = createChildLogger("sandbox-provision");

export class SandboxProvisionService {
  constructor(private readonly agentClient: AgentClient) {}

  async pushSandboxConfig(
    sandboxId: string,
    sandboxConfig: SandboxConfig,
  ): Promise<void> {
    await this.agentClient.setConfig(sandboxId, sandboxConfig);
    log.debug({ sandboxId }, "Sandbox config pushed via setConfig");
  }

  async setHostname(sandboxId: string, hostname: string): Promise<void> {
    const cmd = `hostname "${hostname}" && echo "${hostname}" > /etc/hostname`;
    const result = await this.agentClient.exec(sandboxId, cmd, {
      timeout: 5000,
    });

    if (result.exitCode !== 0) {
      log.warn(
        { sandboxId, exitCode: result.exitCode, stderr: result.stderr },
        "Failed to set hostname",
      );
    } else {
      log.debug({ sandboxId, hostname }, "Hostname set");
    }
  }

  async configureNetwork(
    sandboxId: string,
    network: { ipAddress: string; gateway: string },
  ): Promise<void> {
    const dnsServers = config.network.dnsServers;
    const dnsCommands = dnsServers
      .map((dns) => `echo 'nameserver ${dns}' >> /etc/resolv.conf`)
      .join(" && ");

    const networkCmd = `ip link set lo up && ip addr add ${network.ipAddress}/24 dev eth0 && ip link set eth0 up && ip route add default via ${network.gateway} dev eth0 && > /etc/resolv.conf && ${dnsCommands}`;

    const result = await this.agentClient.exec(sandboxId, networkCmd, {
      timeout: 10000,
    });

    if (result.exitCode !== 0) {
      log.error(
        { sandboxId, exitCode: result.exitCode, stderr: result.stderr },
        "Network configuration failed",
      );
      throw new Error(`Network configuration failed: ${result.stderr}`);
    }

    log.info({ sandboxId, ipAddress: network.ipAddress }, "Network configured");
  }

  async syncClock(sandboxId: string): Promise<void> {
    // Kill stale chronyd (may survive snapshot restore), then restart fresh
    const cmd =
      "pkill chronyd 2>/dev/null; chronyd -f /etc/chrony/chrony.conf 2>/dev/null || true";
    const result = await this.agentClient.exec(sandboxId, cmd, {
      timeout: 5000,
    });

    if (result.exitCode !== 0) {
      log.warn(
        { sandboxId, exitCode: result.exitCode, stderr: result.stderr },
        "Clock sync failed (non-blocking)",
      );
    } else {
      log.debug({ sandboxId }, "chronyd started");
    }
  }

  async pushSecrets(sandboxId: string, envFileContent: string): Promise<void> {
    if (!envFileContent) return;

    await this.agentClient.writeFiles(sandboxId, [
      {
        path: "/etc/sandbox/secrets/.env",
        content: envFileContent,
        mode: "0600",
        owner: "dev",
      },
      {
        path: "/etc/profile.d/99-sandbox-secrets.sh",
        content:
          '[ "$(id -u)" = "1000" ] && [ -r /etc/sandbox/secrets/.env ] && . /etc/sandbox/secrets/.env\n',
      },
    ]);
    log.debug({ sandboxId }, "Secrets pushed");
  }

  async pushRuntimeEnv(
    sandboxId: string,
    env: Record<string, string>,
  ): Promise<void> {
    const content = `${Object.entries(env)
      .map(([k, v]) => `export ${k}=${JSON.stringify(v)}`)
      .join("\n")}\n`;

    await this.agentClient.writeFiles(sandboxId, [
      {
        path: "/etc/sandbox/runtime.env",
        content,
        mode: "0644",
        owner: "root",
      },
      {
        path: "/etc/profile.d/98-atelier-runtime.sh",
        content:
          "[ -r /etc/sandbox/runtime.env ] && . /etc/sandbox/runtime.env\n",
        owner: "root",
      },
    ]);
    log.debug({ sandboxId, keys: Object.keys(env) }, "Runtime env pushed");
  }

  async pushGitCredentials(
    sandboxId: string,
    credentials: string[],
  ): Promise<void> {
    if (credentials.length === 0) return;

    const gitCredentialsContent = `${credentials.join("\n")}\n`;
    const gitconfigContent = `[credential]
 \thelper = store --file=/etc/sandbox/secrets/git-credentials
 [user]
 \temail = ${config.sandbox.git.email}
 \tname = ${config.sandbox.git.name}
 `;

    await this.agentClient.writeFiles(sandboxId, [
      {
        path: "/etc/sandbox/secrets/git-credentials",
        content: gitCredentialsContent,
        mode: "0600",
        owner: "dev",
      },
      {
        path: `${VM.HOME}/.gitconfig`,
        content: gitconfigContent,
        owner: "dev",
      },
    ]);
    log.debug(
      { sandboxId, credentialCount: credentials.length },
      "Git credentials pushed",
    );
  }

  async pushFileSecrets(
    sandboxId: string,
    fileSecrets: { path: string; content: string; mode?: string }[],
  ): Promise<void> {
    if (fileSecrets.length === 0) return;

    const files = fileSecrets.map((secret) => ({
      path: secret.path.replace(/^~/, VM.HOME),
      content: secret.content,
      mode: secret.mode || "0600",
      owner: "dev" as const,
    }));

    await this.agentClient.writeFiles(sandboxId, files);
    log.debug({ sandboxId, fileCount: files.length }, "File secrets pushed");
  }

  async pushOhMyOpenCodeCache(
    sandboxId: string,
    providers: string[],
  ): Promise<void> {
    const cacheContent = JSON.stringify(
      {
        connected: providers,
        updatedAt: new Date().toISOString(),
      },
      null,
      2,
    );

    await this.agentClient.writeFiles(sandboxId, [
      {
        path: `${VM.HOME}/.cache/oh-my-opencode/connected-providers.json`,
        content: cacheContent,
        owner: "dev",
      },
    ]);
    log.debug({ sandboxId, providers }, "OhMyOpenCode cache pushed");
  }

  async pushSandboxMd(sandboxId: string, content: string): Promise<void> {
    await this.agentClient.writeFiles(sandboxId, [
      {
        path: `${VM.HOME}/SANDBOX.md`,
        content,
        owner: "dev",
      },
    ]);
    log.debug({ sandboxId }, "SANDBOX.md pushed");
  }

  async pushRegistryConfig(sandboxId: string): Promise<void> {
    const settings = RegistryService.getSettings();
    if (!settings.enabled) return;

    const registryUrl = RegistryService.getRegistryUrl();
    const bridgeIp = config.network.bridgeIp;

    const files = [
      {
        path: "/etc/profile.d/registry.sh",
        content: `export NPM_CONFIG_REGISTRY="${registryUrl}"`,
      },
      {
        path: "/etc/npmrc",
        content: `registry=${registryUrl}`,
      },
      {
        path: `${VM.HOME}/.bunfig.toml`,
        content: `[install]\nregistry = "${registryUrl}"`,
      },
      {
        path: `${VM.HOME}/.yarnrc.yml`,
        content: `npmRegistryServer: "${registryUrl}"\nunsafeHttpWhitelist:\n  - "${bridgeIp}"`,
      },
    ];

    await this.pushFilesToSandbox(sandboxId, files, "registry");
    log.debug({ sandboxId }, "Registry config pushed");
  }

  async startServices(
    sandboxId: string,
    serviceNames: string[],
  ): Promise<void> {
    await Promise.all(
      serviceNames.map((name) =>
        this.agentClient.serviceStart(sandboxId, name).catch((err) => {
          log.warn(
            { sandboxId, service: name, error: String(err) },
            "Service start failed (non-blocking)",
          );
        }),
      ),
    );
    log.info({ sandboxId, services: serviceNames }, "Services started");
  }

  async pushFilesToSandbox(
    sandboxId: string,
    files: { path: string; content: string; owner?: "dev" | "root" }[],
    label: string,
  ): Promise<void> {
    const fileWrites = files.map((f) => ({
      path: f.path,
      content: f.content,
      owner: f.owner ?? ("dev" as const),
    }));

    try {
      await this.agentClient.writeFiles(sandboxId, fileWrites);
      log.debug({ label, sandboxId, files: files.length }, "Files pushed");
    } catch (error) {
      log.warn({ label, sandboxId, error }, "Failed to push files to sandbox");
      throw error;
    }
  }
}
