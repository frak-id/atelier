import type { SandboxConfig } from "@frak/atelier-shared";
import { SandboxError } from "../../shared/errors.ts";
import { createChildLogger } from "../../shared/lib/logger.ts";
import { kubeClient } from "../kubernetes/index.ts";
import type {
  AgentHealth,
  AgentMetrics,
  BatchExecResult,
  Command,
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
const AGENT_PORT = 9998;

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

export class AgentClient {
  constructor(private readonly kube: typeof kubeClient = kubeClient) {}

  private async getAgentUrl(sandboxId: string): Promise<string> {
    const podIp = await this.kube.getPodIp(`sandbox-${sandboxId}`);
    if (!podIp) {
      throw new AgentUnavailableError(sandboxId, "sandbox pod has no IP yet");
    }
    return `http://${podIp}:${AGENT_PORT}`;
  }

  private async request<T>(
    sandboxId: string,
    path: string,
    options: RequestOptions = {},
  ): Promise<T> {
    const timeout = options.timeout ?? DEFAULT_TIMEOUT;
    const url = `${await this.getAgentUrl(sandboxId)}${path}`;
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
        throw new AgentUnavailableError(
          sandboxId,
          `${response.status} ${response.statusText}`,
        );
      }

      return response.json() as Promise<T>;
    } catch (err) {
      if (err instanceof AgentUnavailableError) throw err;
      throw new AgentUnavailableError(
        sandboxId,
        err instanceof Error ? err.message : String(err),
      );
    } finally {
      clearTimeout(timeoutId);
    }
  }

  private post<T>(
    sandboxId: string,
    path: string,
    body?: unknown,
    timeout?: number,
  ): Promise<T> {
    return this.request<T>(sandboxId, path, { method: "POST", body, timeout });
  }

  async health(sandboxId: string): Promise<AgentHealth> {
    return this.request<AgentHealth>(sandboxId, "/health");
  }

  async waitForAgent(
    sandboxId: string,
    options: { timeout?: number } = {},
  ): Promise<boolean> {
    const timeout = options.timeout ?? 60000;
    const deadline = Date.now() + timeout;
    const podName = `sandbox-${sandboxId}`;

    while (Date.now() < deadline) {
      try {
        const ip = await this.kube.getPodIp(podName);
        if (!ip) {
          await Bun.sleep(500);
          continue;
        }

        const response = await fetch(`http://${ip}:${AGENT_PORT}/health`, {
          signal: AbortSignal.timeout(2000),
        });
        if (response.ok) {
          const health = (await response.json()) as AgentHealth;
          if (health.status === "healthy") {
            log.info({ sandboxId }, "Agent is healthy");
            return true;
          }
        }
      } catch {}

      await Bun.sleep(500);
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
    return this.post<{ success: boolean }>(sandboxId, "/config", config, 10000);
  }

  async writeFiles(
    sandboxId: string,
    files: FileWrite[],
  ): Promise<WriteFilesResult> {
    return this.post<WriteFilesResult>(
      sandboxId,
      "/files/write",
      { files },
      30000,
    );
  }

  async exec(
    sandboxId: string,
    command: string,
    options: { timeout?: number; user?: "dev" | "root"; workdir?: string } = {},
  ): Promise<ExecResult> {
    return this.post<ExecResult>(
      sandboxId,
      "/exec",
      {
        command,
        timeout: options.timeout,
        user: options.user,
        workdir: options.workdir,
      },
      (options.timeout ?? 30000) + 5000,
    );
  }

  async batchExec(
    sandboxId: string,
    commands: Command[],
    options: { timeout?: number } = {},
  ): Promise<BatchExecResult> {
    const maxCmdTimeout = Math.max(...commands.map((c) => c.timeout ?? 30000));
    return this.post<BatchExecResult>(
      sandboxId,
      "/exec/batch",
      { commands },
      options.timeout ?? maxCmdTimeout + 10000,
    );
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
    return this.post<DevStartResult>(
      sandboxId,
      `/dev/${name}/start`,
      devCommand,
      30000,
    );
  }

  async devStop(sandboxId: string, name: string): Promise<DevStopResult> {
    return this.post<DevStopResult>(sandboxId, `/dev/${name}/stop`);
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
    return this.post<ServiceStartResult>(
      sandboxId,
      `/services/${name}/start`,
      undefined,
      30000,
    );
  }

  async serviceStop(
    sandboxId: string,
    name: string,
  ): Promise<ServiceStopResult> {
    return this.post<ServiceStopResult>(sandboxId, `/services/${name}/stop`);
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
    return this.post<GitStatus>(sandboxId, "/git/status", { repos }, 30000);
  }

  async gitDiff(
    sandboxId: string,
    repos: { clonePath: string }[],
  ): Promise<GitDiffResult> {
    return this.post<GitDiffResult>(sandboxId, "/git/diff", { repos }, 30000);
  }

  async gitCommit(
    sandboxId: string,
    repoPath: string,
    message: string,
  ): Promise<GitCommitResult> {
    return this.post<GitCommitResult>(
      sandboxId,
      "/git/commit",
      { repoPath, message },
      30000,
    );
  }

  async gitPush(sandboxId: string, repoPath: string): Promise<GitPushResult> {
    return this.post<GitPushResult>(
      sandboxId,
      "/git/push",
      { repoPath },
      60000,
    );
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
    return this.post<TerminalSessionCreateResult>(
      sandboxId,
      "/terminal/sessions",
      {
        userId,
        title: options?.title,
        command: options?.command,
        workdir: options?.workdir,
      },
      10000,
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
