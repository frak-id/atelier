import { config } from "../../shared/lib/config.ts";
import { createChildLogger } from "../../shared/lib/logger.ts";
import type {
  AgentHealth,
  AgentMetrics,
  AppPort,
  BatchExecResult,
  ConfigFileContent,
  DevCommandListResult,
  DevLogsResult,
  DevStartResult,
  DevStopResult,
  DiscoveredConfig,
  ExecResult,
} from "./agent.types.ts";

const log = createChildLogger("agent");

const DEFAULT_TIMEOUT = 10000;

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

  async batchExec(
    ipAddress: string,
    commands: { id: string; command: string; timeout?: number }[],
    options: { timeout?: number } = {},
  ): Promise<BatchExecResult> {
    const maxCmdTimeout = Math.max(...commands.map((c) => c.timeout ?? 30000));
    return this.request<BatchExecResult>(ipAddress, "/exec/batch", {
      method: "POST",
      body: { commands },
      timeout: options.timeout ?? maxCmdTimeout + 10000,
    });
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

  async devList(ipAddress: string): Promise<DevCommandListResult> {
    return this.request<DevCommandListResult>(ipAddress, "/dev");
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
  ): Promise<DevStartResult> {
    return this.request<DevStartResult>(ipAddress, `/dev/${name}/start`, {
      method: "POST",
      body: devCommand,
      timeout: 30000,
    });
  }

  async devStop(ipAddress: string, name: string): Promise<DevStopResult> {
    return this.request<DevStopResult>(ipAddress, `/dev/${name}/stop`, {
      method: "POST",
    });
  }

  async devLogs(
    ipAddress: string,
    name: string,
    offset: number,
    limit: number,
  ): Promise<DevLogsResult> {
    return this.request<DevLogsResult>(
      ipAddress,
      `/dev/${name}/logs?offset=${offset}&limit=${limit}`,
    );
  }
}
