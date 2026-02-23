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

  async pushGitConfig(sandboxId: string, credentials: string[]): Promise<void> {
    const gitconfigSections = [
      "[user]",
      `\temail = ${config.sandbox.git.email}`,
      `\tname = ${config.sandbox.git.name}`,
    ];

    if (credentials.length > 0) {
      gitconfigSections.unshift(
        "[credential]",
        "\thelper = store --file=/etc/sandbox/secrets/git-credentials",
      );
    }

    gitconfigSections.push("");
    const gitconfigContent = gitconfigSections.join("\n");

    const files: Parameters<typeof this.agentClient.writeFiles>[1] = [
      {
        path: "/etc/gitconfig",
        content: gitconfigContent,
        owner: "root",
      },
    ];

    if (credentials.length > 0) {
      files.push({
        path: "/etc/sandbox/secrets/git-credentials",
        content: `${credentials.join("\n")}\n`,
        mode: "0600",
        owner: "dev",
      });
    }

    await this.agentClient.writeFiles(sandboxId, files);
    log.debug(
      { sandboxId, credentialCount: credentials.length },
      "Git config pushed",
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

  /**
   * Wait for services to be ready by hitting their HTTP health endpoints.
   * Validates end-to-end connectivity (manager → network → VM → service).
   * If this succeeds, Caddy reverse proxy will work too.
   */
  async waitForServicesReady(
    sandboxId: string,
    ipAddress: string,
    serviceNames: string[],
    timeoutMs = 15000,
  ): Promise<void> {
    const healthEndpoints: Record<string, { port: number; path: string }> = {
      vscode: {
        port: config.advanced.vm.vscode.port,
        path: "/healthz",
      },
      opencode: {
        port: config.advanced.vm.opencode.port,
        path: "/health",
      },
    };

    const checks = serviceNames
      .map((name) => {
        const endpoint = healthEndpoints[name];
        if (!endpoint) return null;
        return { name, ...endpoint };
      })
      .filter((c): c is NonNullable<typeof c> => c !== null);

    if (checks.length === 0) return;

    const deadline = Date.now() + timeoutMs;
    const ready = new Set<string>();

    while (Date.now() < deadline && ready.size < checks.length) {
      const pending = checks.filter((c) => !ready.has(c.name));

      await Promise.allSettled(
        pending.map(async (check) => {
          try {
            const res = await fetch(
              `http://${ipAddress}:${check.port}${check.path}`,
              { signal: AbortSignal.timeout(3000) },
            );
            if (res.ok) {
              ready.add(check.name);
            }
          } catch {
            // Service not ready yet
          }
        }),
      );

      if (ready.size < checks.length) {
        await Bun.sleep(500);
      }
    }

    const readyNames = [...ready];
    const notReady = checks
      .filter((c) => !ready.has(c.name))
      .map((c) => c.name);

    if (notReady.length > 0) {
      log.warn(
        { sandboxId, notReady, readyNames, timeoutMs },
        "Some services did not pass health check within timeout",
      );
    } else {
      log.info(
        { sandboxId, services: readyNames },
        "All services confirmed ready via health endpoints",
      );
    }
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
