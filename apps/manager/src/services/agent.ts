/**
 * Agent Client - communicates with sandbox-agent running inside VMs
 * Uses HTTP over the VM network interface (port 9999)
 */

import { createChildLogger } from "../lib/logger.ts";
import { sandboxStore } from "../state/store.ts";

const log = createChildLogger("agent");

const AGENT_PORT = 9999;
const DEFAULT_TIMEOUT = 10000;

interface AgentHealth {
  status: string;
  sandboxId?: string;
  services: {
    vscode: boolean;
    opencode: boolean;
    sshd: boolean;
  };
  uptime: number;
}

interface AgentMetrics {
  cpu: number;
  memory: { total: number; used: number; free: number };
  disk: { total: number; used: number; free: number };
  timestamp: string;
}

interface AppPort {
  port: number;
  name: string;
  registeredAt: string;
}

interface ServiceStatus {
  name: string;
  running: boolean;
  pid?: number;
}

interface ExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

interface EditorConfig {
  vscode: {
    settings: Record<string, unknown>;
    extensions: string[];
  };
  opencode: {
    auth: Record<string, unknown>;
    config: Record<string, unknown>;
  };
}

export const AgentClient = {
  /**
   * Get agent base URL for a sandbox
   */
  getAgentUrl(sandboxId: string): string {
    const sandbox = sandboxStore.getById(sandboxId);
    if (!sandbox) {
      throw new Error(`Sandbox '${sandboxId}' not found`);
    }
    if (!sandbox.ipAddress) {
      throw new Error(`Sandbox '${sandboxId}' has no IP address`);
    }
    return `http://${sandbox.ipAddress}:${AGENT_PORT}`;
  },

  /**
   * Make an HTTP request to the agent
   */
  async request<T>(
    sandboxId: string,
    path: string,
    options: {
      method?: "GET" | "POST" | "PUT" | "DELETE";
      body?: unknown;
      timeout?: number;
    } = {},
  ): Promise<T> {
    const baseUrl = this.getAgentUrl(sandboxId);
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
  },

  /**
   * Check if agent is reachable and healthy
   */
  async health(sandboxId: string): Promise<AgentHealth> {
    return this.request<AgentHealth>(sandboxId, "/health");
  },

  /**
   * Wait for agent to become healthy (with retries)
   */
  async waitForAgent(
    sandboxId: string,
    options: { timeout?: number; interval?: number } = {},
  ): Promise<boolean> {
    const timeout = options.timeout ?? 60000;
    const interval = options.interval ?? 2000;
    const deadline = Date.now() + timeout;

    while (Date.now() < deadline) {
      try {
        const health = await this.health(sandboxId);
        if (health.status === "healthy") {
          log.info({ sandboxId }, "Agent is healthy");
          return true;
        }
      } catch (error) {
        log.debug({ sandboxId, error }, "Agent not ready yet");
      }
      await Bun.sleep(interval);
    }

    log.warn({ sandboxId, timeout }, "Agent did not become healthy in time");
    return false;
  },

  /**
   * Get resource metrics from the sandbox
   */
  async metrics(sandboxId: string): Promise<AgentMetrics> {
    return this.request<AgentMetrics>(sandboxId, "/metrics");
  },

  /**
   * Get sandbox configuration
   */
  async config(sandboxId: string): Promise<Record<string, unknown>> {
    return this.request<Record<string, unknown>>(sandboxId, "/config");
  },

  /**
   * Get registered applications
   */
  async getApps(sandboxId: string): Promise<AppPort[]> {
    return this.request<AppPort[]>(sandboxId, "/apps");
  },

  /**
   * Register an application port
   */
  async registerApp(
    sandboxId: string,
    port: number,
    name: string,
  ): Promise<AppPort> {
    return this.request<AppPort>(sandboxId, "/apps", {
      method: "POST",
      body: { port, name },
    });
  },

  /**
   * Unregister an application port
   */
  async unregisterApp(
    sandboxId: string,
    port: number,
  ): Promise<{ success: boolean }> {
    return this.request<{ success: boolean }>(sandboxId, `/apps/${port}`, {
      method: "DELETE",
    });
  },

  /**
   * Execute a command in the sandbox
   */
  async exec(
    sandboxId: string,
    command: string,
    options: { timeout?: number } = {},
  ): Promise<ExecResult> {
    return this.request<ExecResult>(sandboxId, "/exec", {
      method: "POST",
      body: { command, timeout: options.timeout },
      timeout: (options.timeout ?? 30000) + 5000, // Add 5s buffer for network
    });
  },

  /**
   * Get service logs from the sandbox
   */
  async logs(
    sandboxId: string,
    service: string,
    lines: number = 100,
  ): Promise<{ service: string; content: string }> {
    return this.request<{ service: string; content: string }>(
      sandboxId,
      `/logs/${service}?lines=${lines}`,
    );
  },

  /**
   * Get status of all services
   */
  async services(sandboxId: string): Promise<{ services: ServiceStatus[] }> {
    return this.request<{ services: ServiceStatus[] }>(sandboxId, "/services");
  },

  /**
   * Batch check health of multiple sandboxes
   */
  async batchHealth(
    sandboxIds: string[],
  ): Promise<Map<string, AgentHealth | { error: string }>> {
    const results = new Map<string, AgentHealth | { error: string }>();

    await Promise.all(
      sandboxIds.map(async (id) => {
        try {
          const health = await this.health(id);
          results.set(id, health);
        } catch (error) {
          results.set(id, {
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }),
    );

    return results;
  },

  async getEditorConfig(sandboxId: string): Promise<EditorConfig | null> {
    try {
      return await this.request<EditorConfig>(sandboxId, "/editor-config");
    } catch (error) {
      log.error({ sandboxId, error }, "Failed to get editor config");
      return null;
    }
  },

  async getInstalledExtensions(sandboxId: string): Promise<string[]> {
    try {
      const result = await this.request<{ extensions: string[] }>(
        sandboxId,
        "/vscode/extensions/installed",
      );
      return result.extensions;
    } catch (error) {
      log.error({ sandboxId, error }, "Failed to get installed extensions");
      return [];
    }
  },

  async installExtensions(
    sandboxId: string,
    extensions: string[],
  ): Promise<{ extension: string; success: boolean; error?: string }[]> {
    try {
      const result = await this.request<{
        results: { extension: string; success: boolean; error?: string }[];
      }>(sandboxId, "/vscode/extensions/install", {
        method: "POST",
        body: { extensions },
        timeout: 300000,
      });
      return result.results;
    } catch (error) {
      log.error({ sandboxId, error }, "Failed to install extensions");
      return extensions.map((ext) => ({
        extension: ext,
        success: false,
        error: error instanceof Error ? error.message : String(error),
      }));
    }
  },

  async discoverConfigs(sandboxId: string): Promise<DiscoveredConfig[]> {
    try {
      const result = await this.request<{ configs: DiscoveredConfig[] }>(
        sandboxId,
        "/config/discover",
      );
      return result.configs;
    } catch (error) {
      log.error({ sandboxId, error }, "Failed to discover configs");
      return [];
    }
  },

  async readConfigFile(
    sandboxId: string,
    path: string,
  ): Promise<ConfigFileContent | null> {
    try {
      return await this.request<ConfigFileContent>(
        sandboxId,
        `/config/read?path=${encodeURIComponent(path)}`,
      );
    } catch (error) {
      log.error({ sandboxId, path, error }, "Failed to read config file");
      return null;
    }
  },
};

interface DiscoveredConfig {
  path: string;
  displayPath: string;
  category: "opencode" | "vscode" | "other";
  exists: boolean;
  size?: number;
}

interface ConfigFileContent {
  path: string;
  displayPath: string;
  content: string;
  contentType: "json" | "text";
  size: number;
}
