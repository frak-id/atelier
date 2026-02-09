import { existsSync, statSync } from "node:fs";
import { createConnection, type Socket } from "node:net";
import type { SandboxConfig } from "@frak/atelier-shared";
import { SandboxError } from "../../shared/errors.ts";
import { createChildLogger } from "../../shared/lib/logger.ts";
import { getVsockPath } from "../firecracker/index.ts";
import type {
  AgentHealth,
  AgentMetrics,
  BatchExecResult,
  DevCommandListResult,
  DevLogsResult,
  DevStartResult,
  DevStopResult,
  ExecResult,
  FileWrite,
  GitCommitResult,
  GitDiffResult,
  GitPushResult,
  GitStatus,
  ServiceListResult,
  ServiceStartResult,
  ServiceStatus,
  ServiceStopResult,
  TerminalSession,
  TerminalSessionCreateResult,
  TerminalSessionDeleteResult,
  WriteFilesResult,
} from "./agent.types.ts";

const log = createChildLogger("agent");

const DEFAULT_TIMEOUT = 10000;
const VSOCK_GUEST_PORT = 9998;
const VSOCK_CONNECT_TIMEOUT = 5000;

// When Firecracker is resuming a snapshot or restarting a VM, the vsock UDS can
// briefly disappear and reappear. Waiting a little avoids spurious 503s.
const VSOCK_READY_TIMEOUT = 2000;
const VSOCK_READY_INTERVAL = 50;

// Connection failures can be transient (ENOENT during vsock recreation).
const VSOCK_CONNECT_RETRY_ATTEMPTS = 4;
const VSOCK_CONNECT_RETRY_BASE_DELAY = 75;
const VSOCK_CONNECT_RETRY_MAX_DELAY = 500;

export class AgentUnavailableError extends SandboxError {
  constructor(sandboxId: string, cause: string) {
    super(
      `Agent for sandbox ${sandboxId} is unavailable: ${cause}`,
      "AGENT_UNAVAILABLE",
      503,
    );
    this.name = "AgentUnavailableError";
  }
}

interface RequestOptions {
  method?: "GET" | "POST" | "PUT" | "DELETE";
  body?: unknown;
  timeout?: number;
}

/**
 * Agent client using raw HTTP over Firecracker vsock.
 *
 * Each request opens a fresh vsock connection because Firecracker's vsock
 * multiplexer assigns a unique host-side CID per connection. We do NOT use
 * node:http because Bun's polyfill ignores the `createConnection` option and
 * connects to localhost instead of the provided socket.
 */
export class AgentClient {
  private async request<T>(
    sandboxId: string,
    path: string,
    options: RequestOptions = {},
  ): Promise<T> {
    const timeout = options.timeout ?? DEFAULT_TIMEOUT;
    const vsockPath = getVsockPath(sandboxId);

    const vsockReady = await waitForSocketFile(
      vsockPath,
      VSOCK_READY_TIMEOUT,
      VSOCK_READY_INTERVAL,
    );

    if (!vsockReady) {
      throw new SandboxError(
        `Sandbox ${sandboxId} is not reachable (vsock not ready)`,
        "SANDBOX_NOT_RUNNING",
        503,
      );
    }

    let socket: Socket;
    try {
      socket = await this.connectVsockWithRetry(
        sandboxId,
        vsockPath,
        VSOCK_GUEST_PORT,
      );
    } catch (err) {
      throw new AgentUnavailableError(
        sandboxId,
        err instanceof Error ? err.message : String(err),
      );
    }

    try {
      return await this.rawHttp<T>(socket, path, options, timeout);
    } catch (err) {
      throw new AgentUnavailableError(
        sandboxId,
        err instanceof Error ? err.message : String(err),
      );
    } finally {
      socket.destroy();
    }
  }

  private rawHttp<T>(
    socket: Socket,
    path: string,
    options: RequestOptions,
    timeout: number,
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      let settled = false;
      const settle = (fn: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeoutId);
        fn();
      };

      const timeoutId = setTimeout(() => {
        settle(() =>
          reject(new Error(`Agent request timed out after ${timeout}ms`)),
        );
        socket.destroy();
      }, timeout);

      const method = options.method ?? "GET";
      const bodyStr = options.body ? JSON.stringify(options.body) : undefined;
      const headers: string[] = [
        `${method} ${path} HTTP/1.1`,
        "Host: localhost",
        "Connection: close",
      ];
      if (bodyStr) {
        headers.push("Content-Type: application/json");
        headers.push(`Content-Length: ${Buffer.byteLength(bodyStr)}`);
      }
      headers.push("", "");

      socket.write(headers.join("\r\n"));
      if (bodyStr) {
        socket.write(bodyStr);
      }

      const chunks: Buffer[] = [];
      socket.on("data", (chunk: Buffer) => {
        chunks.push(chunk);
      });

      socket.on("end", () => {
        settle(() => {
          try {
            const raw = Buffer.concat(chunks).toString();
            const result = parseHttpResponse<T>(raw);
            resolve(result);
          } catch (err) {
            reject(err);
          }
        });
      });

      socket.on("error", (err) => {
        settle(() => reject(err));
      });
    });
  }

  private async connectVsockWithRetry(
    sandboxId: string,
    vsockPath: string,
    guestPort: number,
  ): Promise<Socket> {
    let lastError: unknown;

    for (let attempt = 1; attempt <= VSOCK_CONNECT_RETRY_ATTEMPTS; attempt++) {
      try {
        return await this.connectVsock(vsockPath, guestPort);
      } catch (error) {
        lastError = error;

        const retryable = isRetryableConnectError(error);
        const remaining = VSOCK_CONNECT_RETRY_ATTEMPTS - attempt;
        if (!retryable || remaining === 0) {
          break;
        }

        const delay = computeBackoffMs(
          attempt,
          VSOCK_CONNECT_RETRY_BASE_DELAY,
          VSOCK_CONNECT_RETRY_MAX_DELAY,
        );
        log.debug(
          {
            sandboxId,
            vsockPath,
            attempt,
            remaining,
            delay,
            error,
          },
          "Vsock connect failed, retrying",
        );
        await Bun.sleep(delay);

        // If the file disappeared, give it a brief chance to come back.
        if (!existsSync(vsockPath)) {
          await waitForSocketFile(
            vsockPath,
            VSOCK_READY_TIMEOUT,
            VSOCK_READY_INTERVAL,
          );
        }
      }
    }

    throw lastError instanceof Error
      ? lastError
      : new Error(`Vsock connect failed: ${String(lastError)}`);
  }

  private connectVsock(vsockPath: string, guestPort: number): Promise<Socket> {
    return new Promise((resolve, reject) => {
      let settled = false;
      const settle = (fn: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        fn();
      };

      const socket = createConnection({ path: vsockPath }, () => {
        socket.write(`CONNECT ${guestPort}\n`);
      });

      let handshakeData = "";
      const onData = (data: Buffer) => {
        handshakeData += data.toString();
        if (handshakeData.includes("\n")) {
          socket.removeListener("data", onData);
          if (handshakeData.startsWith("OK")) {
            settle(() => resolve(socket));
          } else {
            socket.destroy();
            settle(() =>
              reject(
                new Error(`Vsock handshake failed: ${handshakeData.trim()}`),
              ),
            );
          }
        }
      };

      socket.on("data", onData);
      socket.on("error", (err) => {
        settle(() => reject(err));
      });

      const timer = setTimeout(() => {
        socket.destroy();
        settle(() => reject(new Error("Vsock connection timed out")));
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
    const interval = options.interval ?? 500;
    const deadline = Date.now() + timeout;

    while (Date.now() < deadline) {
      try {
        const health = await this.health(sandboxId);
        if (health.status === "healthy") {
          log.info({ sandboxId }, "Agent is healthy");
          return true;
        }
      } catch (error) {
        log.debug({ sandboxId, error }, "Agent health check failed");
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

  async setConfig(
    sandboxId: string,
    config: SandboxConfig,
  ): Promise<{ success: boolean }> {
    return this.request<{ success: boolean }>(sandboxId, "/config", {
      method: "POST",
      body: config,
      timeout: 10000,
    });
  }

  async writeFiles(
    sandboxId: string,
    files: FileWrite[],
  ): Promise<WriteFilesResult> {
    return this.request<WriteFilesResult>(sandboxId, "/files/write", {
      method: "POST",
      body: { files },
      timeout: 30000,
    });
  }

  async exec(
    sandboxId: string,
    command: string,
    options: { timeout?: number; user?: "dev" | "root"; workdir?: string } = {},
  ): Promise<ExecResult> {
    return this.request<ExecResult>(sandboxId, "/exec", {
      method: "POST",
      body: {
        command,
        timeout: options.timeout,
        user: options.user,
        workdir: options.workdir,
      },
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

  async serviceList(sandboxId: string): Promise<ServiceListResult> {
    return this.request<ServiceListResult>(sandboxId, "/services");
  }

  async serviceStatus(sandboxId: string, name: string): Promise<ServiceStatus> {
    return this.request<ServiceStatus>(sandboxId, `/services/${name}/status`);
  }

  async serviceStart(
    sandboxId: string,
    name: string,
  ): Promise<ServiceStartResult> {
    return this.request<ServiceStartResult>(
      sandboxId,
      `/services/${name}/start`,
      {
        method: "POST",
        timeout: 30000,
      },
    );
  }

  async serviceStop(
    sandboxId: string,
    name: string,
  ): Promise<ServiceStopResult> {
    return this.request<ServiceStopResult>(
      sandboxId,
      `/services/${name}/stop`,
      {
        method: "POST",
      },
    );
  }

  async serviceRestart(
    sandboxId: string,
    name: string,
  ): Promise<ServiceStartResult> {
    return this.request<ServiceStartResult>(
      sandboxId,
      `/services/${name}/restart`,
      {
        method: "POST",
        timeout: 30000,
      },
    );
  }

  async serviceLogs(
    sandboxId: string,
    name: string,
    offset: number,
    limit: number,
  ): Promise<DevLogsResult> {
    return this.request<DevLogsResult>(
      sandboxId,
      `/services/${name}/logs?offset=${offset}&limit=${limit}`,
    );
  }

  async gitStatus(
    sandboxId: string,
    repos: { clonePath: string }[],
  ): Promise<GitStatus> {
    return this.request<GitStatus>(sandboxId, "/git/status", {
      method: "POST",
      body: { repos },
      timeout: 30000,
    });
  }

  async gitDiff(
    sandboxId: string,
    repos: { clonePath: string }[],
  ): Promise<GitDiffResult> {
    return this.request<GitDiffResult>(sandboxId, "/git/diff", {
      method: "POST",
      body: { repos },
      timeout: 30000,
    });
  }

  async gitCommit(
    sandboxId: string,
    repoPath: string,
    message: string,
  ): Promise<GitCommitResult> {
    return this.request<GitCommitResult>(sandboxId, "/git/commit", {
      method: "POST",
      body: { repoPath, message },
      timeout: 30000,
    });
  }

  async gitPush(sandboxId: string, repoPath: string): Promise<GitPushResult> {
    return this.request<GitPushResult>(sandboxId, "/git/push", {
      method: "POST",
      body: { repoPath },
      timeout: 60000,
    });
  }

  async startServices(
    sandboxId: string,
    serviceNames: string[],
  ): Promise<void> {
    await Promise.all(
      serviceNames.map((name) =>
        this.serviceStart(sandboxId, name).catch((err) => {
          console.warn(`Failed to start service ${name}: ${err}`);
        }),
      ),
    );
  }

  async terminalSessionCreate(
    sandboxId: string,
    userId: string,
    options?: { title?: string; command?: string; workdir?: string },
  ): Promise<TerminalSessionCreateResult> {
    return this.request<TerminalSessionCreateResult>(
      sandboxId,
      "/terminal/sessions",
      {
        method: "POST",
        body: {
          userId,
          title: options?.title,
          command: options?.command,
          workdir: options?.workdir,
        },
        timeout: 10000,
      },
    );
  }

  async terminalSessionList(sandboxId: string): Promise<TerminalSession[]> {
    return this.request<TerminalSession[]>(sandboxId, "/terminal/sessions");
  }

  async terminalSessionGet(
    sandboxId: string,
    sessionId: string,
  ): Promise<TerminalSession> {
    return this.request<TerminalSession>(
      sandboxId,
      `/terminal/sessions/${sessionId}`,
    );
  }

  async terminalSessionDelete(
    sandboxId: string,
    sessionId: string,
  ): Promise<TerminalSessionDeleteResult> {
    return this.request<TerminalSessionDeleteResult>(
      sandboxId,
      `/terminal/sessions/${sessionId}`,
      { method: "DELETE" },
    );
  }
}

function isSocketFile(path: string): boolean {
  try {
    return statSync(path).isSocket();
  } catch {
    return false;
  }
}

async function waitForSocketFile(
  path: string,
  timeoutMs: number,
  intervalMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (isSocketFile(path)) return true;
    await Bun.sleep(intervalMs);
  }

  return isSocketFile(path);
}

function getNodeErrorCode(error: unknown): string | undefined {
  if (!error || typeof error !== "object") return undefined;
  const code = (error as Record<string, unknown>).code;
  return typeof code === "string" ? code : undefined;
}

function isRetryableConnectError(error: unknown): boolean {
  const code = getNodeErrorCode(error);
  if (code === "ENOENT") return true;
  if (code === "ECONNREFUSED") return true;
  if (code === "ECONNRESET") return true;
  if (code === "EPIPE") return true;
  if (code === "ETIMEDOUT") return true;

  if (error instanceof Error) {
    const msg = error.message;
    if (msg.includes("Vsock connection timed out")) return true;
    if (msg.includes("Vsock handshake failed")) return true;
  }

  return false;
}

function computeBackoffMs(
  attempt: number,
  baseDelayMs: number,
  maxDelayMs: number,
): number {
  const exp = Math.min(6, attempt - 1);
  const delay = baseDelayMs * 2 ** exp;
  return Math.min(maxDelayMs, delay);
}

function parseHttpResponse<T>(raw: string): T {
  const headerEnd = raw.indexOf("\r\n\r\n");
  if (headerEnd === -1) {
    throw new Error(`Malformed HTTP response: no header boundary`);
  }

  const headerSection = raw.slice(0, headerEnd);
  const bodyRaw = raw.slice(headerEnd + 4);

  const statusLine = headerSection.split("\r\n")[0] ?? "";
  const statusMatch = statusLine.match(/^HTTP\/\d\.\d (\d{3}) (.*)$/);
  if (!statusMatch) {
    throw new Error(`Malformed HTTP status line: ${statusLine}`);
  }

  const statusCode = parseInt(statusMatch[1] ?? "na", 10);
  const statusMessage = statusMatch[2] ?? "undefined";

  if (statusCode < 200 || statusCode >= 300) {
    throw new Error(`Agent request failed: ${statusCode} ${statusMessage}`);
  }

  const isChunked = headerSection
    .toLowerCase()
    .includes("transfer-encoding: chunked");
  const body = isChunked ? decodeChunked(bodyRaw) : bodyRaw;

  try {
    return JSON.parse(body) as T;
  } catch {
    throw new Error(`Failed to parse agent response: ${body.slice(0, 200)}`);
  }
}

function decodeChunked(raw: string): string {
  let result = "";
  let pos = 0;

  while (pos < raw.length) {
    const lineEnd = raw.indexOf("\r\n", pos);
    if (lineEnd === -1) break;

    const sizeStr = raw.slice(pos, lineEnd).trim();
    const size = parseInt(sizeStr, 16);
    if (size === 0) break;

    const chunkStart = lineEnd + 2;
    result += raw.slice(chunkStart, chunkStart + size);
    pos = chunkStart + size + 2;
  }

  return result;
}
