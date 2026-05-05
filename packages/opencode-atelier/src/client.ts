import { treaty } from "@elysiajs/eden";
import type { App } from "@frak/atelier-manager";
import { logger } from "./logger.ts";
import type { AtelierPluginConfig, Sandbox } from "./types.ts";

export type AtelierClient = ReturnType<typeof treaty<App>>;

type ClientGetter = () => AtelierClient;

let _client: AtelierClient | null = null;
let _baseUrl: string | null = null;

export function createClientGetter(config: AtelierPluginConfig): ClientGetter {
  return () => {
    if (!_client || _baseUrl !== config.managerUrl) {
      _baseUrl = config.managerUrl;
      _client = treaty<App>(config.managerUrl, {
        headers: () => {
          const key = config.apiKey;
          return key ? { authorization: `Bearer ${key}` } : {};
        },
      });
    }
    return _client;
  };
}

export function resetClient(): void {
  _client = null;
  _baseUrl = null;
}

export function unwrap<T>(result: { data: T; error: unknown }): NonNullable<T> {
  if (result.error) {
    throw result.error instanceof Error
      ? result.error
      : new Error(String(result.error));
  }
  return result.data as NonNullable<T>;
}

/**
 * Poll the manager until the sandbox transitions to `running`.
 *
 * `POST /sandboxes` already blocks until the agent + opencode are healthy,
 * so this is mostly a safety net for the initial create response and is the
 * canonical way to revive a stale runtime cache entry.
 */
export async function waitForSandboxReady(
  client: AtelierClient,
  sandboxId: string,
  opts: { intervalMs: number; timeoutMs: number },
): Promise<Sandbox> {
  const deadline = Date.now() + opts.timeoutMs;
  let attempt = 0;

  while (Date.now() < deadline) {
    const sandbox = unwrap(await client.api.sandboxes({ id: sandboxId }).get());

    if (sandbox.status === "running") return sandbox as Sandbox;
    if (sandbox.status === "error") {
      throw new Error(`Sandbox ${sandboxId} entered error state`);
    }

    await sleep(backoffDelay(opts.intervalMs, attempt++, deadline));
  }

  throw new Error(
    `Sandbox ${sandboxId} did not become ready within ${opts.timeoutMs}ms`,
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Exponential backoff with a hard cap, clipped to remaining deadline.
 * Starts at `baseMs`, multiplies by 1.5 each attempt, capped at 5s. Logs a
 * heads-up after a few attempts so slow sandboxes don't look hung.
 */
function backoffDelay(
  baseMs: number,
  attempt: number,
  deadline: number,
): number {
  const grown = Math.min(baseMs * 1.5 ** attempt, 5_000);
  if (attempt > 0 && attempt % 5 === 0) {
    logger.info(
      `Still waiting for sandbox readiness (attempt ${attempt}, next in ${Math.round(grown)}ms)`,
    );
  }
  return Math.max(0, Math.min(grown, deadline - Date.now()));
}
