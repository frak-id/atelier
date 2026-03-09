import { treaty } from "@elysiajs/eden";
import type { App } from "@frak/atelier-manager";
import type { AtelierPluginConfig, Sandbox, Task } from "./types.ts";

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
          const token = config.token;
          return token ? { authorization: `Bearer ${token}` } : {};
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

export async function waitForSandboxReady(
  client: AtelierClient,
  sandboxId: string,
  opts: { intervalMs: number; timeoutMs: number },
): Promise<Sandbox> {
  const deadline = Date.now() + opts.timeoutMs;

  while (Date.now() < deadline) {
    const sandbox = unwrap(await client.api.sandboxes({ id: sandboxId }).get());

    if (sandbox.status === "running") return sandbox as Sandbox;
    if (sandbox.status === "error") {
      throw new Error(`Sandbox ${sandboxId} entered error state`);
    }

    await sleep(opts.intervalMs);
  }

  throw new Error(
    `Sandbox ${sandboxId} did not become ready within ${opts.timeoutMs}ms`,
  );
}

export async function waitForTaskSandbox(
  client: AtelierClient,
  taskId: string,
  opts: { intervalMs: number; timeoutMs: number },
): Promise<{ task: Task; sandbox: Sandbox }> {
  const deadline = Date.now() + opts.timeoutMs;

  while (Date.now() < deadline) {
    const task = unwrap(await client.api.tasks({ id: taskId }).get());

    if (task.data.sandboxId) {
      const sandbox = await waitForSandboxReady(client, task.data.sandboxId, {
        intervalMs: opts.intervalMs,
        timeoutMs: Math.max(0, deadline - Date.now()),
      });
      return { task: task as Task, sandbox };
    }

    await sleep(opts.intervalMs);
  }

  throw new Error(
    `Task ${taskId} never received a sandbox within ${opts.timeoutMs}ms`,
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
