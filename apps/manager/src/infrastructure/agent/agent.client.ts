import { config } from "../../shared/lib/config.ts";
import { createChildLogger } from "../../shared/lib/logger.ts";

const log = createChildLogger("agent");

const DEFAULT_TIMEOUT = 10000;

export interface AgentHealth {
  status: string;
  sandboxId?: string;
  services: {
    vscode: boolean;
    opencode: boolean;
    sshd: boolean;
  };
  uptime: number;
}

export interface AgentMetrics {
  cpu: number;
  memory: { total: number; used: number; free: number };
  disk: { total: number; used: number; free: number };
  timestamp: string;
}

export interface AppPort {
  port: number;
  name: string;
  registeredAt: string;
}

export interface ServiceStatus {
  name: string;
  running: boolean;
  pid?: number;
}

export interface ExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface EditorConfig {
  vscode: {
    settings: Record<string, unknown>;
    extensions: string[];
  };
  opencode: {
    auth: Record<string, unknown>;
    config: Record<string, unknown>;
  };
}

export interface GitStatus {
  repos: {
    path: string;
    branch: string | null;
    dirty: boolean;
    ahead: number;
    behind: number;
    lastCommit: string | null;
    error?: string;
  }[];
}

export interface DiscoveredConfig {
  path: string;
  displayPath: string;
  category: "opencode" | "vscode" | "other";
  exists: boolean;
  size?: number;
}

export interface ConfigFileContent {
  path: string;
  displayPath: string;
  content: string;
  contentType: "json" | "text";
  size: number;
}

export class AgentClient {
  private getAgentUrl(ipAddress: string): string {
    return `http://${ipAddress}:${config.raw.services.agent.port}`;
  }

  private async request<T>(
    ipAddress: string,
    path: string,
    options: {
      method?: "GET" | "POST" | "PUT" | "DELETE";
      body?: unknown;
      timeout?: number;
    } = {},
  ): Promise<T> {
    const baseUrl = this.getAgentUrl(ipAddress);
    const url = `${baseUrl}${path}`;
    const timeout = options.timeout ?? DEFAULT_TIMEOUT;

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);

    try {
      const response = await fetch(url, {
        method: options.method ?? "GET",
        headers: options.body
          ? { "Content-Type": "application/json" }
          : undefined,
        body: options.body ? JSON.stringify(options.body) : undefined,
        signal: controller.signal,
      });

      if (!response.ok) {
        throw new Error(
          `Agent request failed: ${response.status} ${response.statusText}`,
        );
      }

      return (await response.json()) as T;
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        throw new Error(`Agent request timed out after ${timeout}ms`);
      }
      throw error;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  async health(ipAddress: string): Promise<AgentHealth> {
    return this.request<AgentHealth>(ipAddress, "/health");
  }

  async waitForAgent(
    ipAddress: string,
    options: { timeout?: number; interval?: number } = {},
  ): Promise<boolean> {
    const timeout = options.timeout ?? 60000;
    const interval = options.interval ?? 2000;
    const deadline = Date.now() + timeout;

    while (Date.now() < deadline) {
      try {
        const health = await this.health(ipAddress);
        if (health.status === "healthy") {
          log.info({ ipAddress }, "Agent is healthy");
          return true;
        }
      } catch (error) {
        log.debug({ ipAddress, error }, "Agent not ready yet");
      }
      await Bun.sleep(interval);
    }

    log.warn({ ipAddress, timeout }, "Agent did not become healthy in time");
    return false;
  }

  async metrics(ipAddress: string): Promise<AgentMetrics> {
    return this.request<AgentMetrics>(ipAddress, "/metrics");
  }

  async config(ipAddress: string): Promise<Record<string, unknown>> {
    return this.request<Record<string, unknown>>(ipAddress, "/config");
  }

  async getApps(ipAddress: string): Promise<AppPort[]> {
    return this.request<AppPort[]>(ipAddress, "/apps");
  }

  async registerApp(
    ipAddress: string,
    port: number,
    name: string,
  ): Promise<AppPort> {
    return this.request<AppPort>(ipAddress, "/apps", {
      method: "POST",
      body: { port, name },
    });
  }

  async unregisterApp(
    ipAddress: string,
    port: number,
  ): Promise<{ success: boolean }> {
    return this.request<{ success: boolean }>(ipAddress, `/apps/${port}`, {
      method: "DELETE",
    });
  }

  async exec(
    ipAddress: string,
    command: string,
    options: { timeout?: number } = {},
  ): Promise<ExecResult> {
    return this.request<ExecResult>(ipAddress, "/exec", {
      method: "POST",
      body: { command, timeout: options.timeout },
      timeout: (options.timeout ?? 30000) + 5000,
    });
  }

  async logs(
    ipAddress: string,
    service: string,
    lines: number = 100,
  ): Promise<{ service: string; content: string }> {
    return this.request<{ service: string; content: string }>(
      ipAddress,
      `/logs/${service}?lines=${lines}`,
    );
  }

  async services(ipAddress: string): Promise<{ services: ServiceStatus[] }> {
    return this.request<{ services: ServiceStatus[] }>(ipAddress, "/services");
  }

  async batchHealth(
    ipAddresses: string[],
  ): Promise<Map<string, AgentHealth | { error: string }>> {
    const results = new Map<string, AgentHealth | { error: string }>();

    await Promise.all(
      ipAddresses.map(async (ip) => {
        try {
          const health = await this.health(ip);
          results.set(ip, health);
        } catch (error) {
          results.set(ip, {
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }),
    );

    return results;
  }

  async getEditorConfig(ipAddress: string): Promise<EditorConfig | null> {
    try {
      return await this.request<EditorConfig>(ipAddress, "/editor-config");
    } catch (error) {
      log.error({ ipAddress, error }, "Failed to get editor config");
      return null;
    }
  }

  async getInstalledExtensions(ipAddress: string): Promise<string[]> {
    try {
      const result = await this.request<{ extensions: string[] }>(
        ipAddress,
        "/vscode/extensions/installed",
      );
      return result.extensions;
    } catch (error) {
      log.error({ ipAddress, error }, "Failed to get installed extensions");
      return [];
    }
  }

  async installExtensions(
    ipAddress: string,
    extensions: string[],
  ): Promise<{ extension: string; success: boolean; error?: string }[]> {
    try {
      const result = await this.request<{
        results: { extension: string; success: boolean; error?: string }[];
      }>(ipAddress, "/vscode/extensions/install", {
        method: "POST",
        body: { extensions },
        timeout: 300000,
      });
      return result.results;
    } catch (error) {
      log.error({ ipAddress, error }, "Failed to install extensions");
      return extensions.map((ext) => ({
        extension: ext,
        success: false,
        error: error instanceof Error ? error.message : String(error),
      }));
    }
  }

  async discoverConfigs(ipAddress: string): Promise<DiscoveredConfig[]> {
    try {
      const result = await this.request<{ configs: DiscoveredConfig[] }>(
        ipAddress,
        "/config/discover",
      );
      return result.configs;
    } catch (error) {
      log.error({ ipAddress, error }, "Failed to discover configs");
      return [];
    }
  }

  async readConfigFile(
    ipAddress: string,
    path: string,
  ): Promise<ConfigFileContent | null> {
    try {
      return await this.request<ConfigFileContent>(
        ipAddress,
        `/config/read?path=${encodeURIComponent(path)}`,
      );
    } catch (error) {
      log.error({ ipAddress, path, error }, "Failed to read config file");
      return null;
    }
  }

  async gitStatus(ipAddress: string): Promise<GitStatus> {
    return this.request<GitStatus>(ipAddress, "/git/status");
  }

  async resizeStorage(ipAddress: string): Promise<{
    success: boolean;
    disk?: { total: number; used: number; free: number };
    error?: string;
  }> {
    return this.request<{
      success: boolean;
      disk?: { total: number; used: number; free: number };
      error?: string;
    }>(ipAddress, "/storage/resize", { method: "POST", timeout: 60000 });
  }

  async getStorageInfo(ipAddress: string): Promise<{
    filesystem: { total: number; used: number; free: number };
    blockDevice: number;
    canResize: boolean;
    error?: string;
  }> {
    return this.request<{
      filesystem: { total: number; used: number; free: number };
      blockDevice: number;
      canResize: boolean;
      error?: string;
    }>(ipAddress, "/storage/info");
  }

  async devList(ipAddress: string): Promise<{
    commands: Array<{
      name: string;
      status: string;
      pid?: number;
      port?: number;
      startedAt?: string;
      exitCode?: number;
    }>;
  }> {
    return this.request<{
      commands: Array<{
        name: string;
        status: string;
        pid?: number;
        port?: number;
        startedAt?: string;
        exitCode?: number;
      }>;
    }>(ipAddress, "/dev");
  }

  async devStart(
    ipAddress: string,
    name: string,
    devCommand: {
      command: string;
      workdir?: string;
      env?: Record<string, string>;
      port?: number;
    },
  ): Promise<{
    status: string;
    pid?: number;
    name: string;
    port?: number;
    logFile?: string;
    startedAt?: string;
  }> {
    return this.request(ipAddress, `/dev/${name}/start`, {
      method: "POST",
      body: devCommand,
      timeout: 30000,
    });
  }

  async devStop(
    ipAddress: string,
    name: string,
  ): Promise<{
    status: string;
    name: string;
    pid?: number;
    message?: string;
    exitCode?: number;
  }> {
    return this.request(ipAddress, `/dev/${name}/stop`, {
      method: "POST",
    });
  }

  async devLogs(
    ipAddress: string,
    name: string,
    offset: number,
    limit: number,
  ): Promise<{ name: string; content: string; nextOffset: number }> {
    return this.request(
      ipAddress,
      `/dev/${name}/logs?offset=${offset}&limit=${limit}`,
    );
  }
}
