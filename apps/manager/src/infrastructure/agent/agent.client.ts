import { request as httpRequest, type IncomingMessage } from "node:http";
import { createConnection, type Socket } from "node:net";
import { createChildLogger } from "../../shared/lib/logger.ts";
import { getVsockPath } from "../firecracker/index.ts";
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
const VSOCK_GUEST_PORT = 9998;
const VSOCK_CONNECT_TIMEOUT = 5000;

interface RequestOptions {
  method?: "GET" | "POST" | "PUT" | "DELETE";
  body?: unknown;
  timeout?: number;
}

export class AgentClient {
  private sockets = new Map<string, Socket>();

  private getSocket(sandboxId: string): Socket | undefined {
    const socket = this.sockets.get(sandboxId);
    if (socket && !socket.destroyed) {
      return socket;
    }
    this.sockets.delete(sandboxId);
    return undefined;
  }

  private async getOrCreateSocket(sandboxId: string): Promise<Socket> {
    const existing = this.getSocket(sandboxId);
    if (existing) return existing;

    const vsockPath = getVsockPath(sandboxId);
    const socket = await this.connectVsock(vsockPath, VSOCK_GUEST_PORT);

    socket.on("close", () => {
      this.sockets.delete(sandboxId);
    });
    socket.on("error", () => {
      this.sockets.delete(sandboxId);
    });

    this.sockets.set(sandboxId, socket);
    return socket;
  }

  disconnect(sandboxId: string): void {
    const socket = this.sockets.get(sandboxId);
    if (socket) {
      socket.destroy();
      this.sockets.delete(sandboxId);
    }
  }

  private async request<T>(
    sandboxId: string,
    path: string,
    options: RequestOptions = {},
  ): Promise<T> {
    const timeout = options.timeout ?? DEFAULT_TIMEOUT;

    try {
      const socket = await this.getOrCreateSocket(sandboxId);
      return await this.httpOverSocket<T>(socket, path, options, timeout);
    } catch (error) {
      // Connection may have gone stale — retry once with a fresh socket
      this.disconnect(sandboxId);
      const socket = await this.getOrCreateSocket(sandboxId);
      return this.httpOverSocket<T>(socket, path, options, timeout);
    }
  }

  private httpOverSocket<T>(
    socket: Socket,
    path: string,
    options: RequestOptions,
    timeout: number,
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        reject(new Error(`Agent request timed out after ${timeout}ms`));
      }, timeout);

      const req = httpRequest(
        {
          path,
          method: options.method ?? "GET",
          headers: {
            Host: "localhost",
            Connection: "keep-alive",
            ...(options.body ? { "Content-Type": "application/json" } : {}),
          },
          createConnection: () => socket,
        },
        (res: IncomingMessage) => {
          let body = "";
          res.on("data", (chunk) => {
            body += chunk;
          });
          res.on("end", () => {
            clearTimeout(timeoutId);
            if (
              !res.statusCode ||
              res.statusCode < 200 ||
              res.statusCode >= 300
            ) {
              reject(
                new Error(
                  `Agent request failed: ${res.statusCode} ${res.statusMessage}`,
                ),
              );
              return;
            }
            try {
              resolve(JSON.parse(body) as T);
            } catch {
              reject(
                new Error(
                  `Failed to parse agent response: ${body.slice(0, 200)}`,
                ),
              );
            }
          });
        },
      );

      req.on("error", (err) => {
        clearTimeout(timeoutId);
        reject(err);
      });

      if (options.body) {
        req.write(JSON.stringify(options.body));
      }
      req.end();
    });
  }

  private connectVsock(vsockPath: string, guestPort: number): Promise<Socket> {
    return new Promise((resolve, reject) => {
      const socket = createConnection({ path: vsockPath }, () => {
        socket.write(`CONNECT ${guestPort}\n`);
      });

      let handshakeData = "";
      const onData = (data: Buffer) => {
        handshakeData += data.toString();
        if (handshakeData.includes("\n")) {
          socket.removeListener("data", onData);
          if (handshakeData.startsWith("OK")) {
            resolve(socket);
          } else {
            socket.destroy();
            reject(
              new Error(`Vsock handshake failed: ${handshakeData.trim()}`),
            );
          }
        }
      };

      socket.on("data", onData);
      socket.on("error", reject);

      setTimeout(() => {
        socket.destroy();
        reject(new Error("Vsock connection timed out"));
      }, VSOCK_CONNECT_TIMEOUT);
    });
  }

  async health(sandboxId: string): Promise<AgentHealth> {
    return this.request<AgentHealth>(sandboxId, "/health");
  }

  async waitForAgent(
    sandboxId: string,
    options: { timeout?: number; interval?: number } = {},
  ): Promise<boolean> {
    const timeout = options.timeout ?? 60000;
    const interval = options.interval ?? 50;
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
  }

  async metrics(sandboxId: string): Promise<AgentMetrics> {
    return this.request<AgentMetrics>(sandboxId, "/metrics");
  }

  async config(sandboxId: string): Promise<Record<string, unknown>> {
    return this.request<Record<string, unknown>>(sandboxId, "/config");
  }

  async exec(
    sandboxId: string,
    command: string,
    options: { timeout?: number } = {},
  ): Promise<ExecResult> {
    return this.request<ExecResult>(sandboxId, "/exec", {
      method: "POST",
      body: { command, timeout: options.timeout },
      timeout: (options.timeout ?? 30000) + 5000,
    });
  }

  async batchExec(
    sandboxId: string,
    commands: { id: string; command: string; timeout?: number }[],
    options: { timeout?: number } = {},
  ): Promise<BatchExecResult> {
    const maxCmdTimeout = Math.max(...commands.map((c) => c.timeout ?? 30000));
    return this.request<BatchExecResult>(sandboxId, "/exec/batch", {
      method: "POST",
      body: { commands },
      timeout: options.timeout ?? maxCmdTimeout + 10000,
    });
  }

  async getApps(sandboxId: string): Promise<AppPort[]> {
    return this.request<AppPort[]>(sandboxId, "/apps");
  }

  async registerApp(
    sandboxId: string,
    port: number,
    name: string,
  ): Promise<AppPort> {
    return this.request<AppPort>(sandboxId, "/apps", {
      method: "POST",
      body: { port, name },
    });
  }

  async unregisterApp(
    sandboxId: string,
    port: number,
  ): Promise<{ success: boolean }> {
    return this.request<{ success: boolean }>(sandboxId, `/apps/${port}`, {
      method: "DELETE",
    });
  }

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
  }

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
  }

  async devList(sandboxId: string): Promise<DevCommandListResult> {
    return this.request<DevCommandListResult>(sandboxId, "/dev");
  }

  async devStart(
    sandboxId: string,
    name: string,
    devCommand: {
      command: string;
      workdir?: string;
      env?: Record<string, string>;
      port?: number;
    },
  ): Promise<DevStartResult> {
    return this.request<DevStartResult>(sandboxId, `/dev/${name}/start`, {
      method: "POST",
      body: devCommand,
      timeout: 30000,
    });
  }

  async devStop(sandboxId: string, name: string): Promise<DevStopResult> {
    return this.request<DevStopResult>(sandboxId, `/dev/${name}/stop`, {
      method: "POST",
    });
  }

  async devLogs(
    sandboxId: string,
    name: string,
    offset: number,
    limit: number,
  ): Promise<DevLogsResult> {
    return this.request<DevLogsResult>(
      sandboxId,
      `/dev/${name}/logs?offset=${offset}&limit=${limit}`,
    );
  }
}
