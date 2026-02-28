import type { SandboxConfig } from "@frak/atelier-shared";
import { VM } from "@frak/atelier-shared/constants";
import type { AgentClient } from "../../infrastructure/agent/agent.client.ts";
import type { FileWrite } from "../../infrastructure/agent/agent.types.ts";
import { RegistryService } from "../../infrastructure/registry/index.ts";
import { config } from "../../shared/lib/config.ts";
import { createChildLogger } from "../../shared/lib/logger.ts";

const log = createChildLogger("sandbox-provision");

export class SandboxProvisionService {
  constructor(private readonly agentClient: AgentClient) {}

  // ── Collect methods (return FileWrite[] for batching) ───────────────

  collectDnsFiles(): FileWrite[] {
    const dnsServers = config.network.dnsServers;
    const content = `${dnsServers.map((dns) => `nameserver ${dns}`).join("\n")}\n`;
    return [{ path: "/etc/resolv.conf", content }];
  }

  collectHostnameFile(hostname: string): FileWrite {
    return { path: "/etc/hostname", content: `${hostname}\n` };
  }

  collectRuntimeEnvFiles(env: Record<string, string>): FileWrite[] {
    const content = `${Object.entries(env)
      .map(([k, v]) => `export ${k}=${JSON.stringify(v)}`)
      .join("\n")}\n`;
    return [
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
    ];
  }

  collectSecretsFiles(envFileContent: string): FileWrite[] {
    if (!envFileContent) return [];
    return [
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
    ];
  }

  collectGitConfigFiles(credentials: string[]): FileWrite[] {
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

    const files: FileWrite[] = [
      { path: "/etc/gitconfig", content: gitconfigContent, owner: "root" },
    ];

    if (credentials.length > 0) {
      files.push({
        path: "/etc/sandbox/secrets/git-credentials",
        content: `${credentials.join("\n")}\n`,
        mode: "0600",
        owner: "dev",
      });
    }

    return files;
  }

  collectFileSecretsFiles(
    fileSecrets: { path: string; content: string; mode?: string }[],
  ): FileWrite[] {
    return fileSecrets.map((secret) => ({
      path: secret.path.replace(/^~/, VM.HOME),
      content: secret.content,
      mode: secret.mode || "0600",
      owner: "dev" as const,
    }));
  }

  collectOhMyOpenCodeCacheFiles(providers: string[]): FileWrite[] {
    const content = JSON.stringify(
      { connected: providers, updatedAt: new Date().toISOString() },
      null,
      2,
    );
    return [
      {
        path: `${VM.HOME}/.cache/oh-my-opencode/connected-providers.json`,
        content,
        owner: "dev",
      },
    ];
  }

  collectSandboxMdFile(content: string): FileWrite {
    return { path: `${VM.HOME}/SANDBOX.md`, content, owner: "dev" };
  }

  collectRegistryConfigFiles(): FileWrite[] {
    const settings = RegistryService.getSettings();
    if (!settings.enabled) return [];

    const registryUrl = RegistryService.getRegistryUrl();
    const bridgeIp = config.network.bridgeIp;

    return [
      {
        path: "/etc/profile.d/registry.sh",
        content: `export NPM_CONFIG_REGISTRY="${registryUrl}"`,
      },
      { path: "/etc/npmrc", content: `registry=${registryUrl}` },
      {
        path: `${VM.HOME}/.bunfig.toml`,
        content: `[install]\nregistry = "${registryUrl}"`,
      },
      {
        path: `${VM.HOME}/.yarnrc.yml`,
        content: `npmRegistryServer: "${registryUrl}"\nunsafeHttpWhitelist:\n  - "${bridgeIp}"`,
      },
    ];
  }

  // ── Push methods (collect + send, for runtime sync to running VMs) ──

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

  async configureDns(sandboxId: string): Promise<void> {
    const files = this.collectDnsFiles();
    await this.agentClient.writeFiles(sandboxId, files);
    log.debug({ sandboxId }, "DNS configured");
  }

  async syncClock(sandboxId: string): Promise<void> {
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
    const files = this.collectSecretsFiles(envFileContent);
    if (files.length === 0) return;
    await this.agentClient.writeFiles(sandboxId, files);
    log.debug({ sandboxId }, "Secrets pushed");
  }

  async pushRuntimeEnv(
    sandboxId: string,
    env: Record<string, string>,
  ): Promise<void> {
    const files = this.collectRuntimeEnvFiles(env);
    await this.agentClient.writeFiles(sandboxId, files);
    log.debug({ sandboxId, keys: Object.keys(env) }, "Runtime env pushed");
  }

  async pushGitConfig(sandboxId: string, credentials: string[]): Promise<void> {
    const files = this.collectGitConfigFiles(credentials);
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
    const files = this.collectFileSecretsFiles(fileSecrets);
    await this.agentClient.writeFiles(sandboxId, files);
    log.debug({ sandboxId, fileCount: files.length }, "File secrets pushed");
  }

  async pushOhMyOpenCodeCache(
    sandboxId: string,
    providers: string[],
  ): Promise<void> {
    const files = this.collectOhMyOpenCodeCacheFiles(providers);
    await this.agentClient.writeFiles(sandboxId, files);
    log.debug({ sandboxId, providers }, "OhMyOpenCode cache pushed");
  }

  async pushSandboxMd(sandboxId: string, content: string): Promise<void> {
    const file = this.collectSandboxMdFile(content);
    await this.agentClient.writeFiles(sandboxId, [file]);
    log.debug({ sandboxId }, "SANDBOX.md pushed");
  }

  async pushRegistryConfig(sandboxId: string): Promise<void> {
    const files = this.collectRegistryConfigFiles();
    if (files.length === 0) return;
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
