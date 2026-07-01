import { createOpencodeClient } from "@opencode-ai/sdk/v2";
import { config } from "../../../shared/lib/config.ts";
import {
  buildOpenCodeAuthHeaders,
  createTimeoutFetch,
} from "./opencode-auth.ts";

export type SandboxOpencodeClient = ReturnType<typeof createOpencodeClient>;

/**
 * Construct an OpenCode SDK client pointed at a sandbox's `opencode serve`.
 * Ported verbatim from v1 `shared/lib/opencode-client.ts`.
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
