/**
 * Typed thin client over the `/v1` runtime API. No apps/server imports — pure
 * HTTP + the shared `@atelier/spec` contracts, so the CLI is exactly as
 * privileged as any other API caller.
 */
import type {
  CreateSandboxResponse,
  ExecRequest,
  ResumeRequest,
  SandboxSpec,
  SandboxState,
  SandboxSummary,
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
}
