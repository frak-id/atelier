import { version as serverVersion } from "../../../package.json";
import { SandboxError } from "../../shared/errors.ts";
import { createChildLogger } from "../../shared/lib/logger.ts";
import type { AgentActivityReport } from "../activity.ts";
import type { AgentConfig } from "../agent-config.ts";
import type { AgentEndpoint } from "../backend/backend.types.ts";
import {
  BUILD_TIMEOUT_MS,
  EXEC_DEFAULT_TIMEOUT_MS,
  EXEC_MARGIN_MS,
  hookPhaseTimeoutMs,
  MATERIALIZE_TIMEOUT_MS,
} from "./agent.contract.ts";
import type {
  AgentHealth,
  AgentProcessListResult,
  DevLogsResult,
  ExecResult,
  FileWrite,
  HookPhase,
  HookPhaseResult,
  TerminalSession,
  TerminalSessionCreateResult,
  TerminalSessionDeleteResult,
  WriteFilesResult,
} from "./agent.types.ts";

const log = createChildLogger("agent");

const DEFAULT_TIMEOUT = 10000;

/** Backoff before each `GET /ssh/host-keys` attempt (the agent has only just
 * come up when boot asks). */
const HOST_KEY_RETRY_DELAYS_MS = [0, 500, 2_000];

/**
 * Resolve where a sandbox's agent is reachable ({@link AgentEndpoint}), or
 * `null` while compute isn't ready. The composition root wires this to the
 * active backend's `resolveAgentEndpoint` so a Docker container's mapped host
 * ports are dialed and a pod's IP is used on Kubernetes.
 */
export type AgentEndpointResolver = (
  sandboxId: string,
) => Promise<AgentEndpoint | null>;

/**
 * Look up the per-sandbox agent token (`generated.agentPassword` on the
 * record) when this process hasn't seen the sandbox boot, e.g. after a server
 * restart. A sandbox that is booting (or a throwaway build pod) has no record
 * yet; its token comes from {@link AgentClient.setToken}.
 */
export type AgentTokenResolver = (sandboxId: string) => string | undefined;

class AgentUnavailableError extends SandboxError {
  constructor(sandboxId: string, cause: string) {
    super(
      `Agent for sandbox ${sandboxId} is unavailable: ${cause}`,
      "AGENT_UNAVAILABLE",
      503,
    );
    this.name = "AgentUnavailableError";
  }
}

/** The agent answered but rejected the request (4xx) — a caller error, not
 * an availability problem: don't dress it up as a 503. Propagates the
 * agent's status code so a validation failure surfaces as one. */
class AgentRequestError extends SandboxError {
  constructor(sandboxId: string, status: number, detail: string) {
    super(
      `Agent for sandbox ${sandboxId} rejected the request: ${detail}`,
      "AGENT_REQUEST_FAILED",
      status,
    );
    this.name = "AgentRequestError";
  }
}

interface RequestOptions {
  method?: "GET" | "POST" | "PUT" | "DELETE";
  body?: unknown;
  timeout?: number;
  /** Caller cancellation (e.g. a canceled job) — combined with the per-request
   * timeout so an in-flight agent call (a long build step, a capture push)
   * aborts promptly instead of running to completion after cancel. */
  signal?: AbortSignal;
}

export class AgentClient {
  // An endpoint is stable for the sandbox's compute lifetime and only changes
  // when compute is recreated (restart/recover) or removed — each preceded by
  // a stop. Caching it spares a resolution round-trip on every one of the
  // ~10-20 agent calls a single spawn issues.
  private readonly endpointCache = new Map<string, AgentEndpoint>();
  // The agent refuses everything but `GET /health` without this bearer token.
  private readonly tokens = new Map<string, string>();
  // Sandboxes already checked for an agent/server version mismatch.
  private readonly versionChecked = new Set<string>();

  constructor(
    private readonly resolveEndpoint: AgentEndpointResolver,
    private readonly resolveToken: AgentTokenResolver = () => undefined,
  ) {}

  /**
   * Register the agent token a boot just generated for a sandbox (or a
   * throwaway build pod) so calls made before its record exists authenticate.
   */
  setToken(sandboxId: string, token: string): void {
    this.tokens.set(sandboxId, token);
  }

  private tokenFor(sandboxId: string): string | undefined {
    const known = this.tokens.get(sandboxId);
    if (known) return known;
    const resolved = this.resolveToken(sandboxId);
    if (resolved) this.tokens.set(sandboxId, resolved);
    return resolved;
  }

  private authHeaders(sandboxId: string): Record<string, string> {
    const token = this.tokenFor(sandboxId);
    return token ? { Authorization: `Bearer ${token}` } : {};
  }

  /** Warn once per sandbox when the agent's release differs from the
   * server's: a rebuilt base image can lag (or lead) the server, and a strict
   * config schema then fails with an unexplained 400. */
  private checkVersion(sandboxId: string, agentVersion: string | undefined) {
    if (this.versionChecked.has(sandboxId)) return;
    this.versionChecked.add(sandboxId);
    if (agentVersion === serverVersion) return;
    log.warn(
      { sandboxId, agentVersion: agentVersion ?? "unknown", serverVersion },
      "Agent version differs from the server's; rebuild the base image if requests start failing",
    );
  }

  /**
   * Drop the cached endpoint for a sandbox. Callers invoke this whenever
   * compute is recreated or removed (restart/recover/destroy) — an explicit
   * call, so the runtime stays free of any domain event bus/schema dependency.
   */
  invalidatePodIp(sandboxId: string): void {
    this.endpointCache.delete(sandboxId);
    this.versionChecked.delete(sandboxId);
  }

  private async getAgentUrl(sandboxId: string): Promise<string> {
    const ep = await this.resolveEndpointCached(sandboxId);
    return `http://${ep.host}:${ep.agentPort}`;
  }

  private async resolveEndpointCached(
    sandboxId: string,
  ): Promise<AgentEndpoint> {
    const cached = this.endpointCache.get(sandboxId);
    if (cached) return cached;

    const endpoint = await this.resolveEndpoint(sandboxId);
    if (!endpoint) {
      throw new AgentUnavailableError(
        sandboxId,
        "sandbox agent has no endpoint yet",
      );
    }
    this.endpointCache.set(sandboxId, endpoint);
    return endpoint;
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
    // The fetch aborts on EITHER the timeout OR the caller's cancellation.
    const signal = options.signal
      ? AbortSignal.any([controller.signal, options.signal])
      : controller.signal;

    try {
      const response = await fetch(url, {
        method: options.method ?? "GET",
        headers: {
          ...this.authHeaders(sandboxId),
          ...(options.body ? { "Content-Type": "application/json" } : {}),
        },
        body: options.body ? JSON.stringify(options.body) : undefined,
        signal,
      });

      if (!response.ok) {
        // Surface the agent's own error detail when it sends one (e.g. the
        // toolset capture secret-scan gate reports exactly which file
        // tripped it) — falling back to the bare status line otherwise.
        const detail = await response
          .clone()
          .json()
          .then((body) => (body as { error?: string })?.error)
          .catch(() => undefined);
        const message = detail ?? `${response.status} ${response.statusText}`;
        // 4xx: the agent is alive and refusing — a caller error. Only
        // 5xx/transport failures mean "unavailable".
        if (response.status >= 400 && response.status < 500) {
          throw new AgentRequestError(sandboxId, response.status, message);
        }
        throw new AgentUnavailableError(sandboxId, message);
      }

      return response.json() as Promise<T>;
    } catch (err) {
      if (err instanceof AgentRequestError) throw err;
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
    signal?: AbortSignal,
  ): Promise<T> {
    return this.request<T>(sandboxId, path, {
      method: "POST",
      body,
      timeout,
      signal,
    });
  }

  async health(sandboxId: string): Promise<AgentHealth> {
    const health = await this.request<AgentHealth>(sandboxId, "/health");
    this.checkVersion(sandboxId, health.version);
    return health;
  }

  /**
   * The agent's last hour of measured activity (`GET /activity`: network
   * bytes, file writes, CPU). Throws `AgentUnavailableError` when the agent
   * can't be reached.
   */
  async activity(sandboxId: string): Promise<AgentActivityReport> {
    return this.request<AgentActivityReport>(sandboxId, "/activity", {
      timeout: 5000,
    });
  }

  /**
   * Fetch the sandbox's sshd host public key line(s) (`GET /ssh/host-keys`)
   * for SSH host-key pinning (runtime/boot.ts / ssh/proxy.ts). Retries
   * transient failures (the agent has only just come up), then throws.
   * Empty when the image has no sshd host keys.
   */
  async getSshHostKeys(sandboxId: string): Promise<string[]> {
    let lastError: unknown;
    for (const delayMs of HOST_KEY_RETRY_DELAYS_MS) {
      if (delayMs > 0) await Bun.sleep(delayMs);
      try {
        const res = await this.request<{ keys: string[] }>(
          sandboxId,
          "/ssh/host-keys",
        );
        return res.keys;
      } catch (err) {
        lastError = err;
        log.debug(
          { sandboxId, err: err instanceof Error ? err.message : String(err) },
          "ssh host-key fetch failed; retrying",
        );
      }
    }
    const reason =
      lastError instanceof Error ? lastError.message : String(lastError);
    throw new Error(
      `Could not fetch ssh host keys for sandbox ${sandboxId}: ${reason}`,
    );
  }

  /**
   * Push the projected config into the guest agent (`PUT /config`). The
   * agent stores + validates it but does NOT autostart processes — the runtime
   * drives the phase order (postCreate -> reconcile -> postStart) explicitly.
   * Config is pushed, never ConfigMap-mounted: `env` may hold resolved secrets
   * that must not land in etcd or a pause snapshot.
   */
  async putConfig(sandboxId: string, config: AgentConfig): Promise<void> {
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
    // Each command may take its own full limit, so the abort has to cover
    // the phase's command count (read off the config the agent holds).
    const { hooks } = await this.request<AgentConfig>(sandboxId, "/config");
    return this.post<HookPhaseResult>(
      sandboxId,
      `/hooks/${phase}`,
      undefined,
      hookPhaseTimeoutMs(hooks?.[phase]?.length ?? 0),
    );
  }

  /**
   * Start all non-lazy processes not already running (`POST /reconcile`) — the
   * "processes" phase. Returns once starts are issued; readiness is gated
   * separately via `waitForPrimary`.
   */
  async reconcile(sandboxId: string): Promise<void> {
    await this.post(sandboxId, "/reconcile", undefined, 15000);
  }

  async waitForAgent(
    sandboxId: string,
    options: { timeout?: number } = {},
  ): Promise<{ ready: boolean; podIp: string | null }> {
    const timeout = options.timeout ?? 60000;
    const deadline = Date.now() + timeout;

    while (Date.now() < deadline) {
      try {
        const endpoint = await this.resolveEndpoint(sandboxId);
        if (!endpoint) {
          await Bun.sleep(200);
          continue;
        }

        // `/health` is the one open route: no token needed (and none exists
        // in the record yet for a sandbox that is still booting).
        const response = await fetch(
          `http://${endpoint.host}:${endpoint.agentPort}/health`,
          { signal: AbortSignal.timeout(2000) },
        );
        // Gate on the agent being *alive* (any /health 200), not on primary
        // readiness: the runtime pushes config only after the agent is up, and
        // gates on the primary separately via waitForPrimary after reconcile.
        if (response.ok) {
          const health = (await response.json()) as AgentHealth;
          this.checkVersion(sandboxId, health.version);
          this.endpointCache.set(sandboxId, endpoint);
          log.info({ sandboxId, podIp: endpoint.host }, "Agent is alive");
          return { ready: true, podIp: endpoint.host };
        }
      } catch {}

      await Bun.sleep(200);
    }

    log.warn({ sandboxId, timeout }, "Agent did not come alive in time");
    return { ready: false, podIp: null };
  }

  /**
   * Block until the spec's `primary` process is ready (`/health` healthy) — a
   * generic, harness-agnostic boot gate (any process can be `primary`, not
   * just opencode). Returns true immediately when no primary is declared
   * (liveness == health).
   */
  async waitForPrimary(
    sandboxId: string,
    options: { timeout?: number } = {},
  ): Promise<boolean> {
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

  // ── Supervised process control (agent `/processes`) ──────────────────────

  async processList(sandboxId: string): Promise<AgentProcessListResult> {
    return this.request<AgentProcessListResult>(sandboxId, "/processes");
  }

  async processStart(sandboxId: string, name: string): Promise<void> {
    await this.post(sandboxId, `/processes/${name}/start`, undefined, 30000);
  }

  async processStop(sandboxId: string, name: string): Promise<void> {
    await this.post(sandboxId, `/processes/${name}/stop`, undefined, 30000);
  }

  async processLogs(
    sandboxId: string,
    name: string,
    offset = 0,
    limit = 1_000_000,
  ): Promise<DevLogsResult> {
    return this.request<DevLogsResult>(
      sandboxId,
      `/processes/${name}/logs?offset=${offset}&limit=${limit}`,
    );
  }

  /** WS URL for a process's stdio/PTY attach bridge (single-writer for rw,
   * fan-out for ro). The process must be `stdio: bridge` or `pty`. The agent
   * token rides in the query: the relays dial this bare URL. `replay: false`
   * skips the agent's buffered-output replay for this client (live output
   * only). */
  async attachUrl(
    sandboxId: string,
    name: string,
    mode: "rw" | "ro" = "rw",
    options: { replay?: boolean } = {},
  ): Promise<string> {
    const ep = await this.resolveEndpointCached(sandboxId);
    const query = new URLSearchParams({ mode });
    if (options.replay === false) query.set("replay", "0");
    this.addToken(sandboxId, query);
    return `ws://${ep.host}:${ep.attachPort}/attach/${name}?${query}`;
  }

  /** Raw WS URL for a terminal session (byte relay, no ACP). Terminals ride
   * the attach port at `/terminal/{id}`; that port varies per backend (fixed
   * on k8s, mapped on Docker), so the URL is shaped here rather than by the
   * caller. */
  async terminalBridgeUrl(
    sandboxId: string,
    sessionId: string,
  ): Promise<string> {
    const ep = await this.resolveEndpointCached(sandboxId);
    const query = new URLSearchParams();
    this.addToken(sandboxId, query);
    return `ws://${ep.host}:${ep.attachPort}/terminal/${sessionId}?${query}`;
  }

  private addToken(sandboxId: string, query: URLSearchParams): void {
    const token = this.tokenFor(sandboxId);
    if (token) query.set("token", token);
  }

  /**
   * Build+push a toolset artifact from declared home path-sets (agent
   * `POST /toolsets/build`). The agent stages the paths, packs them into a
   * blob (erofs/squashfs/tar) and `oras push`es it to `target` from inside the
   * pod; the runtime never handles the bytes.
   * Returns the pushed manifest digest (`sha256:…`).
   */
  async buildToolset(
    sandboxId: string,
    body: { target: string; paths: string[] },
    signal?: AbortSignal,
  ): Promise<{ digest: string }> {
    return this.post<{ digest: string }>(
      sandboxId,
      "/toolsets/build",
      body,
      BUILD_TIMEOUT_MS,
      signal,
    );
  }

  /**
   * Capture a live sandbox's declared path-sets into a toolset artifact
   * (agent `POST /toolsets/capture`). The agent packs `paths` MINUS the
   * merged exclude globs, secret-scans the included files (failing unless a
   * finding is covered by `overrides`), and `oras push`es to `target` —
   * mirrors `buildToolset`'s push tail. Returns the pushed manifest digest.
   */
  async captureToolset(
    sandboxId: string,
    body: {
      target: string;
      paths: string[];
      exclude: string[];
      overrides: string[];
    },
    signal?: AbortSignal,
  ): Promise<{ digest: string }> {
    return this.post<{ digest: string }>(
      sandboxId,
      "/toolsets/capture",
      body,
      BUILD_TIMEOUT_MS,
      signal,
    );
  }

  /**
   * Assemble the `/home/dev` overlay before the files/env phase (agent
   * `POST /toolsets`, docs/archive/proposals/toolset-overlay-squashfs.md §5). `references` are full,
   * digest-pinned pull refs (`<registry>/toolsets/<name>@sha256:…`), ordered
   * — later wins (topmost overlay lower). The agent pulls each squashfs blob
   * to `/data/toolsets` (skipped if already present — the resume case),
   * loop-mounts it read-only, and assembles the `/home/dev` overlay with the
   * blobs as lowers over `/home/skel`, upper `/data/upper`.
   *
   * ALWAYS called, even with an empty `references` — the entrypoint never
   * mounts `/home/dev` (see `sandbox-boot.sh`), so this is the only place
   * `/home/dev` is ever assembled; an empty list still produces the
   * skel-only overlay every sandbox needs. Also the signal the entrypoint
   * waits on (`/run/home-ready`) before starting sshd — the race-free
   * handshake replacing the old base-overlay-then-remount design. Idempotent
   * and safe to call on every boot, including resume.
   *
   * The agent enforces a single global deadline across its whole
   * pull/mount/assembly loop, however many toolsets are requested; the
   * client timeout sits above it ({@link MATERIALIZE_TIMEOUT_MS}, see
   * agent.contract.ts) so the agent's own "pulled X of N" error lands first.
   */
  async materializeToolsets(
    sandboxId: string,
    references: string[],
  ): Promise<void> {
    await this.post(
      sandboxId,
      "/toolsets",
      { toolsets: references },
      MATERIALIZE_TIMEOUT_MS,
    );
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
    options: {
      timeout?: number;
      user?: "dev" | "root";
      workdir?: string;
      signal?: AbortSignal;
    } = {},
  ): Promise<ExecResult> {
    // Always name the timeout: the agent's own default is longer than the
    // client would wait, which turned a slow command into a 503.
    const timeout = options.timeout ?? EXEC_DEFAULT_TIMEOUT_MS;
    return this.post<ExecResult>(
      sandboxId,
      "/exec",
      {
        command,
        timeout,
        user: options.user,
        workdir: options.workdir,
      },
      timeout + EXEC_MARGIN_MS,
      options.signal,
    );
  }

  async terminalSessionCreate(
    sandboxId: string,
    userId: string,
    options?: {
      title?: string;
      command?: string;
      workdir?: string;
      /** Extra env for the shell (terminal capability hints). */
      env?: Record<string, string>;
    },
  ): Promise<TerminalSessionCreateResult> {
    return this.post<TerminalSessionCreateResult>(
      sandboxId,
      "/terminal/sessions",
      {
        userId,
        title: options?.title,
        command: options?.command,
        workdir: options?.workdir,
        env: options?.env,
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
