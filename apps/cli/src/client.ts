/**
 * Typed thin client over the `/v1` runtime API. No apps/server imports — pure
 * HTTP + the shared `@atelier/spec` contracts, so the CLI is exactly as
 * privileged as any other API caller.
 */
import type {
  AddPortRequest,
  AddProcessRequest,
  CreateSandboxResponse,
  ExecRequest,
  PatchEnvRequest,
  PatchFilesRequest,
  PrebuildRecord,
  PrebuildSpec,
  ResumeRequest,
  SandboxSpec,
  SandboxState,
  SandboxSummary,
  SnapshotRef,
  ToolboxConfig,
  ToolboxConfigInput,
  ToolboxConfigPatch,
  ToolboxVersion,
  ToolboxVersionCaptureRequest,
  ToolboxVersionList,
  ToolsetBuildRequest,
  ToolsetCaptureRequest,
  ToolsetEntry,
  ToolsetRef,
} from "@atelier/spec";
import type { CliConfig } from "./config.ts";

/** `POST /exec` result (runtime.exec → agent ExecResult). */
export interface ExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/** `GET /processes/:name/logs` result (byte-windowed). */
export interface LogsResult {
  name: string;
  content: string;
  nextOffset: number;
}

/**
 * A registered/built base image (`GET/POST /v1/images`). Server-internal
 * type, not part of `@atelier/spec` (the runtime's `images` table is not a
 * seam contract) — defined locally so the CLI stays a pure HTTP client with
 * no `apps/server` import.
 */
export interface ImageRecord {
  name: string;
  provenance: "seed" | "dockerfile" | "external";
  status: "building" | "ready" | "error";
  ref?: string;
  seedId?: string;
  dockerfile?: string;
  digest?: string;
  buildLog?: string;
  error?: string;
  createdAt: string;
  updatedAt: string;
}

/** An embedded base-image seed template (`GET /v1/images/templates`). */
export interface SeedTemplate {
  id: string;
  name: string;
  description: string;
  volumeSize: number;
  tools: string[];
  base: string | null;
  official: boolean;
  dependsOn: string[];
  substitutions: unknown[];
}

/** `GET /v1/images/:name/logs` result. */
export interface ImageLogs {
  status: ImageRecord["status"];
  log: string;
}

/** One server-config entry (`GET /api/config`). */
export interface ServerConfigEntry {
  key: string;
  label: string;
  description: string;
  type: "boolean" | "number";
  value: boolean | number;
  default: boolean | number;
  isDefault: boolean;
  updatedAt: string | null;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export class AtelierClient {
  constructor(private readonly cfg: CliConfig) {}

  private async req<T>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<T> {
    const res = await fetch(`${this.cfg.baseUrl}/v1${path}`, {
      method,
      headers: {
        authorization: `Bearer ${this.cfg.apiKey}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!res.ok) {
      let msg = `${res.status} ${res.statusText}`;
      try {
        const parsed = (await res.json()) as {
          error?: string;
          message?: string;
        };
        msg = parsed.error ?? parsed.message ?? msg;
      } catch {
        // non-JSON body; keep the status line
      }
      throw new ApiError(res.status, msg);
    }
    if (res.status === 204) return undefined as T;
    return (await res.json()) as T;
  }

  /** Control-plane request (`/api/*`) — org-scoped resources (toolboxes,
   * secrets, org policy…), same Bearer auth as `req`, distinct base path. */
  private async ctl<T>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<T> {
    const res = await fetch(`${this.cfg.baseUrl}/api${path}`, {
      method,
      headers: {
        authorization: `Bearer ${this.cfg.apiKey}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!res.ok) {
      let msg = `${res.status} ${res.statusText}`;
      try {
        const parsed = (await res.json()) as {
          error?: string;
          message?: string;
        };
        msg = parsed.error ?? parsed.message ?? msg;
      } catch {
        // non-JSON body; keep the status line
      }
      throw new ApiError(res.status, msg);
    }
    if (res.status === 204) return undefined as T;
    return (await res.json()) as T;
  }

  create(spec: SandboxSpec): Promise<CreateSandboxResponse> {
    return this.req("POST", "/sandboxes", spec);
  }

  list(): Promise<SandboxSummary[]> {
    return this.req("GET", "/sandboxes");
  }

  get(id: string): Promise<SandboxState> {
    return this.req("GET", `/sandboxes/${id}`);
  }

  pause(id: string): Promise<unknown> {
    return this.req("POST", `/sandboxes/${id}/pause`);
  }

  resume(id: string, req: ResumeRequest): Promise<SandboxState> {
    return this.req("POST", `/sandboxes/${id}/resume`, req);
  }

  destroy(id: string): Promise<void> {
    return this.req("DELETE", `/sandboxes/${id}`);
  }

  logs(id: string, processName: string): Promise<LogsResult> {
    return this.req("GET", `/sandboxes/${id}/processes/${processName}/logs`);
  }

  exec(id: string, req: ExecRequest): Promise<ExecResult> {
    return this.req("POST", `/sandboxes/${id}/exec`, req);
  }

  patchFiles(id: string, files: PatchFilesRequest): Promise<void> {
    return this.req("PATCH", `/sandboxes/${id}/files`, files);
  }

  patchEnv(id: string, env: PatchEnvRequest): Promise<void> {
    return this.req("PATCH", `/sandboxes/${id}/env`, env);
  }

  addProcess(id: string, proc: AddProcessRequest): Promise<void> {
    return this.req("POST", `/sandboxes/${id}/processes`, proc);
  }

  processAction(
    id: string,
    name: string,
    action: "start" | "stop",
  ): Promise<void> {
    return this.req(
      "POST",
      `/sandboxes/${id}/processes/${encodeURIComponent(name)}/${action}`,
    );
  }

  addPort(id: string, req: AddPortRequest): Promise<void> {
    return this.req("POST", `/sandboxes/${id}/ports`, req);
  }

  snapshot(id: string): Promise<SnapshotRef> {
    return this.req("POST", `/sandboxes/${id}/snapshot`);
  }

  prebuild(spec: PrebuildSpec, force = false): Promise<SnapshotRef> {
    return this.req("POST", `/prebuilds${force ? "?force=true" : ""}`, spec);
  }

  listPrebuilds(): Promise<PrebuildRecord[]> {
    return this.req("GET", "/prebuilds");
  }

  deletePrebuild(ref: string): Promise<void> {
    return this.req("DELETE", `/prebuilds/${encodeURIComponent(ref)}`);
  }

  listImages(): Promise<ImageRecord[]> {
    return this.req("GET", "/images");
  }

  listImageTemplates(): Promise<SeedTemplate[]> {
    return this.req("GET", "/images/templates");
  }

  getImage(name: string): Promise<ImageRecord> {
    return this.req("GET", `/images/${encodeURIComponent(name)}`);
  }

  imageLogs(name: string): Promise<ImageLogs> {
    return this.req("GET", `/images/${encodeURIComponent(name)}/logs`);
  }

  /** Build an embedded seed in the operator's own cluster (202, async — poll
   * `imageLogs`/`getImage` for progress). */
  buildSeedImage(seed: string, force = false): Promise<ImageRecord> {
    return this.req("POST", "/images", { seed, force });
  }

  /** Build a user-supplied Dockerfile (202, async). */
  buildDockerfileImage(name: string, dockerfile: string): Promise<ImageRecord> {
    return this.req("POST", "/images", { name, dockerfile });
  }

  /** Register an externally-hosted image (e.g. GHCR) by reference — no
   * build, ready immediately. */
  registerImage(name: string, ref: string): Promise<ImageRecord> {
    return this.req("POST", "/images/register", { name, ref });
  }

  deleteImage(name: string): Promise<void> {
    return this.req("DELETE", `/images/${encodeURIComponent(name)}`);
  }

  listToolsets(): Promise<ToolsetEntry[]> {
    return this.req("GET", "/toolsets");
  }

  buildToolset(req: ToolsetBuildRequest): Promise<ToolsetRef> {
    return this.req("POST", "/toolsets", req);
  }

  captureToolset(
    sandboxId: string,
    req: ToolsetCaptureRequest,
  ): Promise<ToolsetRef> {
    return this.req("POST", `/sandboxes/${sandboxId}/toolsets/capture`, req);
  }

  publishToolset(ref: string): Promise<ToolsetEntry> {
    return this.req("POST", "/toolsets/publish", { ref });
  }

  removeToolset(ref: string): Promise<void> {
    return this.req("DELETE", `/toolsets?ref=${encodeURIComponent(ref)}`);
  }

  /** `owner` is the `?owner=` scope: `org:<id>` | `user`/`me` (self, the
   * default). Absent → the caller's own toolboxes. */
  listToolboxes(owner?: string): Promise<ToolboxConfig[]> {
    return this.ctl(
      "GET",
      `/toolboxes${owner ? `?owner=${encodeURIComponent(owner)}` : ""}`,
    );
  }

  createToolbox(
    input: ToolboxConfigInput,
    owner?: string,
  ): Promise<ToolboxConfig> {
    return this.ctl(
      "POST",
      `/toolboxes${owner ? `?owner=${encodeURIComponent(owner)}` : ""}`,
      input,
    );
  }

  updateToolbox(id: string, patch: ToolboxConfigPatch): Promise<ToolboxConfig> {
    return this.ctl("PATCH", `/toolboxes/${id}`, patch);
  }

  deleteToolbox(id: string): Promise<void> {
    return this.ctl("DELETE", `/toolboxes/${id}`);
  }

  listToolboxVersions(id: string): Promise<ToolboxVersionList> {
    return this.ctl("GET", `/toolboxes/${id}/versions`);
  }

  captureToolboxVersion(
    id: string,
    req: ToolboxVersionCaptureRequest,
  ): Promise<ToolboxVersion> {
    return this.ctl("POST", `/toolboxes/${id}/versions/capture`, req);
  }

  setActiveToolboxVersion(
    id: string,
    versionId: string | null,
  ): Promise<{ activeVersionId: string | null }> {
    return this.ctl("PUT", `/toolboxes/${id}/active-version`, { versionId });
  }

  deleteToolboxVersion(id: string, versionId: string): Promise<void> {
    return this.ctl(
      "DELETE",
      `/toolboxes/${id}/versions/${encodeURIComponent(versionId)}`,
    );
  }

  /** Server-wide runtime config (the config plane). List every key with its
   * value/type/default, or set one key. */
  listConfig(): Promise<ServerConfigEntry[]> {
    return this.ctl("GET", "/config");
  }

  setConfig(
    key: string,
    value: boolean | number,
  ): Promise<{ key: string; value: boolean | number }> {
    return this.ctl("PUT", `/config/${encodeURIComponent(key)}`, { value });
  }

  /** WS attach endpoint + auth header for the unified stdio/PTY bridge. The
   * server proxies to the pod's :9997 bridge (rw). */
  wsAttach(
    id: string,
    name: string,
  ): { url: string; headers: Record<string, string> } {
    const wsBase = this.cfg.baseUrl.replace(/^http/, "ws");
    return {
      url: `${wsBase}/v1/sandboxes/${id}/attach/${name}`,
      headers: { authorization: `Bearer ${this.cfg.apiKey}` },
    };
  }
}
