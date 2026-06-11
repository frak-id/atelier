import { createOpencodeClient } from "@opencode-ai/sdk/v2";
import { config } from "./config.ts";
import {
  buildOpenCodeAuthHeaders,
  createTimeoutFetch,
} from "./opencode-auth.ts";

export type SandboxOpencodeClient = ReturnType<typeof createOpencodeClient>;

/**
 * Construct an OpenCode SDK client pointed at a sandbox's `opencode serve`.
 *
 * Pass `timeoutMs` for poll loops that must fail fast (the SDK has no built-in
 * per-request timeout); pass `port` only for the temporary warmup server,
 * which listens off the standard sandbox port.
 */
export function createSandboxOpencodeClient(
  ipAddress: string,
  password?: string,
  options: { timeoutMs?: number; port?: number } = {},
): SandboxOpencodeClient {
  const port = options.port ?? config.ports.opencode;
  return createOpencodeClient({
    baseUrl: `http://${ipAddress}:${port}`,
    headers: buildOpenCodeAuthHeaders(password),
    ...(options.timeoutMs !== undefined && {
      fetch: createTimeoutFetch(options.timeoutMs),
    }),
  });
}
