/**
 * Typed client over the server API via Eden Treaty (`treaty<App>`) — the same
 * pattern the console uses, so every call is checked against the server's
 * route types. No runtime coupling: `App` is a type-only import, the CLI is
 * still just an HTTP client with a Bearer key.
 */
import type { App } from "@atelier/server";
import { treaty } from "@elysiajs/eden";
import type { CliConfig } from "./config.ts";

export type AtelierApi = ReturnType<typeof treaty<App>>;

/** Build the Treaty client over the runtime's global `fetch`; the Bearer key
 * rides every request. */
export function createClient(cfg: CliConfig): AtelierApi {
  return treaty<App>(cfg.baseUrl, {
    headers: { authorization: `Bearer ${cfg.apiKey}` },
  });
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

/** Pull a human message out of Eden's error envelope (`{ status, value }`),
 * where `value` is the server's `{ error, message }` body. */
function edenMessage(value: unknown, status: number): string {
  if (value && typeof value === "object") {
    const v = value as { message?: unknown; error?: unknown };
    if (typeof v.message === "string") return v.message;
    if (typeof v.error === "string") return v.error;
  }
  if (typeof value === "string" && value) return value;
  return `HTTP ${status}`;
}

/** Unwrap an awaited Treaty response: return `data` or throw {@link ApiError}.
 * Usage: `unwrap(await api.v1.sandboxes.get())`. */
export function unwrap<T>(res: {
  data: T | null;
  error: { status?: unknown; value?: unknown } | null;
}): T {
  if (res.error) {
    const status =
      typeof res.error.status === "number" ? res.error.status : 500;
    throw new ApiError(status, edenMessage(res.error.value, status));
  }
  return res.data as T;
}

/** A durable long-running runtime op — shape derived from the live route type
 * so it can never drift from the server. */
export type JobRecord = NonNullable<
  Awaited<ReturnType<AtelierApi["v1"]["jobs"]["get"]>>["data"]
>[number];

/** A base-image record — shape derived from the live route type. */
export type ImageRow = NonNullable<
  Awaited<ReturnType<AtelierApi["v1"]["images"]["get"]>>["data"]
>[number];

/** Block on a dispatched job until it settles, returning its result. The
 * async endpoints (prebuild bake, toolset build/capture, sandbox create) answer
 * `202` with a `running` job; the CLI polls to keep the "wait then print the
 * ref" UX.
 *
 * `onTick` is awaited after every poll — including the initial state and the
 * terminal one — so callers can stream progress (e.g. a boot log) and still see
 * the final output before a failure throws. */
export async function waitForJob<T>(
  api: AtelierApi,
  job: JobRecord,
  opts: {
    onTick?: (job: JobRecord) => void | Promise<void>;
    intervalMs?: number;
  } = {},
): Promise<T> {
  const intervalMs = opts.intervalMs ?? 1000;
  let current = job;
  await opts.onTick?.(current);
  while (current.status === "queued" || current.status === "running") {
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
    current = unwrap(await api.v1.jobs({ id: current.id }).get());
    await opts.onTick?.(current);
  }
  if (current.status === "succeeded") return current.result as T;
  throw new ApiError(
    current.status === "canceled" ? 499 : 500,
    current.error ?? `job ${current.status}`,
  );
}

/** WS attach endpoint + auth header for the unified stdio/PTY bridge. */
export function wsAttach(
  cfg: CliConfig,
  id: string,
  name: string,
): { url: string; headers: Record<string, string> } {
  const wsBase = cfg.baseUrl.replace(/^http/, "ws");
  return {
    url: `${wsBase}/v1/sandboxes/${id}/attach/${name}`,
    headers: { authorization: `Bearer ${cfg.apiKey}` },
  };
}
