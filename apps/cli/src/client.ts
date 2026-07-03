/**
 * Typed thin client over the `/v1` runtime API. No apps/server imports — pure
 * HTTP + the shared `@atelier/spec` contracts, so the CLI is exactly as
 * privileged as any other API caller.
 */
import type {
  AddPortRequest,
  CreateSandboxResponse,
  ExecRequest,
  PatchFilesRequest,
  PrebuildSpec,
  ResumeRequest,
  SandboxSpec,
  SandboxState,
  SandboxSummary,
  SnapshotRef,
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

  addPort(id: string, req: AddPortRequest): Promise<void> {
    return this.req("POST", `/sandboxes/${id}/ports`, req);
  }

  snapshot(id: string): Promise<SnapshotRef> {
    return this.req("POST", `/sandboxes/${id}/snapshot`);
  }

  prebuild(spec: PrebuildSpec): Promise<SnapshotRef> {
    return this.req("POST", "/prebuilds", spec);
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
