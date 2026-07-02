import { SandboxError } from "../../shared/errors.ts";
import { isMock } from "../../shared/lib/config.ts";
import { createChildLogger } from "../../shared/lib/logger.ts";
import type { AgentConfig } from "../agent-config.ts";
import { kubeClient } from "../kube/index.ts";
import type {
  AcpBridgeSession,
  AcpBridgeSessionDeleteResult,
  AcpBridgeSessionSpec,
  AgentHealth,
  AgentProcessListResult,
  BatchExecResult,
  Command,
  DevLogsResult,
  ExecResult,
  FileWrite,
  GitCommitResult,
  GitDiffResult,
  GitPushResult,
  GitStatus,
  HookPhase,
  HookPhaseResult,
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
/** Unified attach bridge (WS), separate from the HTTP control plane. */
const ATTACH_PORT = 9997;

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
  // A pod's IP is stable for its lifetime and only changes when the pod is
  // recreated (restart/recover) or removed — each preceded by a stop that
  // emits sandbox.updated/deleted. Caching it spares a K8s GET on every one
  // of the ~10-20 agent calls a single spawn issues.
  private readonly podIpCache = new Map<string, string>();

  constructor(private readonly kube: typeof kubeClient = kubeClient) {}

  /**
   * Drop the cached pod IP for a sandbox. Callers invoke this whenever the pod
   * is recreated or removed (restart/recover/destroy). Replaces v1's implicit
   * eventBus subscription — the runtime stays free of the domain event schema.
   */
  invalidatePodIp(sandboxId: string): void {
    this.podIpCache.delete(sandboxId);
  }

  /** Public pod-IP resolution — used by callers that need to dial the pod
   * directly (e.g. the terminal WS bridge), bypassing the agent HTTP API. */
  async getPodIp(sandboxId: string): Promise<string> {
    return this.resolvePodIp(sandboxId);
  }

  private async getAgentUrl(sandboxId: string): Promise<string> {
    return `http://${await this.resolvePodIp(sandboxId)}:${AGENT_PORT}`;
  }

  private async resolvePodIp(sandboxId: string): Promise<string> {
    const cached = this.podIpCache.get(sandboxId);
    if (cached) return cached;

    const podIp = await this.kube.getPodIp(`sandbox-${sandboxId}`);
    if (!podIp) {
      throw new AgentUnavailableError(sandboxId, "sandbox pod has no IP yet");
    }
    this.podIpCache.set(sandboxId, podIp);
    return podIp;
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

  /**
   * Push the projected config into the guest agent (`PUT /config`). The v2
   * agent stores + validates it but does NOT autostart processes — the runtime
   * drives the phase order (postCreate -> reconcile -> postStart) explicitly.
   * Config is pushed, never ConfigMap-mounted: `env` may hold resolved secrets
   * that must not land in etcd or a pause snapshot.
   */
  async putConfig(sandboxId: string, config: AgentConfig): Promise<void> {
    if (isMock()) return;
    await this.request(sandboxId, "/config", {
      method: "PUT",
      body: config,
      timeout: 15000,
    });
  }

  /**
   * Run a lifecycle phase's hooks in the guest (`POST /hooks/{phase}`), in
   * order, fail-fast. The runtime owns *when* each phase fires; the agent owns
   * the commands (from pushed config) and how they run.
   */
  async runHook(sandboxId: string, phase: HookPhase): Promise<HookPhaseResult> {
    if (isMock()) return { success: true, results: [] };
    return this.post<HookPhaseResult>(
      sandboxId,
      `/hooks/${phase}`,
      undefined,
      130000,
    );
  }

  /**
   * Start all non-lazy processes not already running (`POST /reconcile`) — the
   * "processes" phase. Returns once starts are issued; readiness is gated
   * separately via `waitForPrimary`.
   */
  async reconcile(sandboxId: string): Promise<void> {
    if (isMock()) return;
    await this.post(sandboxId, "/reconcile", undefined, 15000);
  }

  async waitForAgent(
    sandboxId: string,
    options: { timeout?: number } = {},
  ): Promise<{ ready: boolean; podIp: string | null }> {
    if (isMock()) {
      const ip = "10.42.0.99";
      this.podIpCache.set(sandboxId, ip);
      return { ready: true, podIp: ip };
    }

    const timeout = options.timeout ?? 60000;
    const deadline = Date.now() + timeout;
    const podName = `sandbox-${sandboxId}`;

    while (Date.now() < deadline) {
      try {
        const ip = await this.kube.getPodIp(podName);
        if (!ip) {
          await Bun.sleep(200);
          continue;
        }

        const response = await fetch(`http://${ip}:${AGENT_PORT}/health`, {
          signal: AbortSignal.timeout(2000),
        });
        // Gate on the agent being *alive* (any /health 200), not on primary
        // readiness: the runtime pushes config only after the agent is up, and
        // gates on the primary separately via waitForPrimary after reconcile.
        if (response.ok) {
          this.podIpCache.set(sandboxId, ip);
          log.info({ sandboxId, podIp: ip }, "Agent is alive");
          return { ready: true, podIp: ip };
        }
      } catch {}

      await Bun.sleep(200);
    }

    log.warn({ sandboxId, timeout }, "Agent did not come alive in time");
    return { ready: false, podIp: null };
  }

  /**
   * Block until the spec's `primary` process is ready (`/health` healthy) — the
   * generic boot gate replacing v1's hardcoded opencode `/health` wait. Returns
   * true immediately when no primary is declared (liveness == health).
   */
  async waitForPrimary(
    sandboxId: string,
    options: { timeout?: number } = {},
  ): Promise<boolean> {
    if (isMock()) return true;
    const deadline = Date.now() + (options.timeout ?? 120000);
    while (Date.now() < deadline) {
      try {
        const health = await this.health(sandboxId);
        if (health.healthy) return true;
      } catch {}
      await Bun.sleep(200);
    }
    return false;
  }

  // ── v2 supervised process control (agent-v2 `/processes`) ───────────────

  async processList(sandboxId: string): Promise<AgentProcessListResult> {
    if (isMock()) return { processes: [] };
    return this.request<AgentProcessListResult>(sandboxId, "/processes");
  }

  async processStart(sandboxId: string, name: string): Promise<void> {
    if (isMock()) return;
    await this.post(sandboxId, `/processes/${name}/start`, undefined, 30000);
  }

  async processStop(sandboxId: string, name: string): Promise<void> {
    if (isMock()) return;
    await this.post(sandboxId, `/processes/${name}/stop`, undefined, 30000);
  }

  async processLogs(
    sandboxId: string,
    name: string,
    offset = 0,
    limit = 1_000_000,
  ): Promise<DevLogsResult> {
    if (isMock()) return { name, content: "", nextOffset: 0 };
    return this.request<DevLogsResult>(
      sandboxId,
      `/processes/${name}/logs?offset=${offset}&limit=${limit}`,
    );
  }

  /** WS URL for a process's stdio/PTY attach bridge (single-writer for rw,
   * fan-out for ro). The process must be `stdio: bridge` or `pty`. */
  async attachUrl(
    sandboxId: string,
    name: string,
    mode: "rw" | "ro" = "rw",
  ): Promise<string> {
    const podIp = await this.resolvePodIp(sandboxId);
    return `ws://${podIp}:${ATTACH_PORT}/attach/${name}?mode=${mode}`;
  }

  async writeFiles(
    sandboxId: string,
    files: FileWrite[],
  ): Promise<WriteFilesResult> {
    if (isMock()) {
      return {
        results: files.map((f) => ({ path: f.path, success: true })),
      };
    }
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
    if (isMock()) {
      return { exitCode: 0, stdout: "", stderr: "" };
    }
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

  async serviceList(sandboxId: string): Promise<ServiceListResult> {
    if (isMock()) return { services: [] };
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

  /**
   * Spawn an ACP harness subprocess in the pod and return the bridge session
   * handle. The manager then opens a WebSocket to the ACP bridge port and
   * speaks ACP JSON-RPC (see AgentDispatch).
   */
  async acpSessionCreate(
    sandboxId: string,
    spec: AcpBridgeSessionSpec = {},
  ): Promise<AcpBridgeSession> {
    return this.post<AcpBridgeSession>(sandboxId, "/acp/sessions", spec, 15000);
  }

  async acpSessionDelete(
    sandboxId: string,
    sessionId: string,
  ): Promise<AcpBridgeSessionDeleteResult> {
    return this.request<AcpBridgeSessionDeleteResult>(
      sandboxId,
      `/acp/sessions/${sessionId}`,
      { method: "DELETE" },
    );
  }

  /**
   * Resolve the WebSocket URL for an ACP bridge session. The bridge listens on
   * its own port (config.ports.acp), separate from the agent control plane.
   */
  async acpWebSocketUrl(
    sandboxId: string,
    sessionId: string,
    acpPort: number,
  ): Promise<string> {
    const podIp = await this.resolvePodIp(sandboxId);
    return `ws://${podIp}:${acpPort}/${sessionId}`;
  }
}
