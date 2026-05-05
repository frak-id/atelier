import { createOpencodeClient } from "@opencode-ai/sdk/v2";
import type { KubeClient } from "../../infrastructure/kubernetes/index.ts";
import { config } from "../../shared/lib/config.ts";
import { createChildLogger } from "../../shared/lib/logger.ts";
import { buildOpenCodeAuthHeaders } from "../../shared/lib/opencode-auth.ts";

const log = createChildLogger("boot-waiter");

const OPENCODE_HEALTH_TIMEOUT_MS = 120_000;
const POLL_INITIAL_DELAY_MS = 100;
const POLL_MAX_DELAY_MS = 500;

export async function waitForPodIp(
  kube: KubeClient,
  podName: string,
  timeout = 60000,
): Promise<string | null> {
  const deadline = Date.now() + timeout;

  while (Date.now() < deadline) {
    const ip = await kube.getPodIp(podName);
    if (ip) {
      return ip;
    }
    await Bun.sleep(500);
  }

  log.warn({ podName, timeout }, "Pod did not get IP in time");
  return null;
}

/**
 * Wait until the OpenCode HTTP server responds healthy.
 *
 * This is the fast "is the binary up and listening" check — typically <1s
 * after `systemctl start opencode` on a warm prebuild. Use this for sandbox
 * spawn/restart workflows where we just need to confirm the service is alive.
 *
 * NOTE: a healthy `/health` does NOT guarantee that the agent registry is
 * loaded. Calling `session.promptAsync` before the registry is ready will
 * silently drop the prompt. Either use `waitForOpencodeReady` before issuing
 * prompts, or rely on the built-in registry wait inside `openOpencodeSession`.
 */
export async function waitForOpencodeHealthy(
  ipAddress: string,
  password?: string,
  timeout = OPENCODE_HEALTH_TIMEOUT_MS,
): Promise<void> {
  await pollOpencode(ipAddress, password, timeout, isOpencodeHealthy);
}

/**
 * Wait until OpenCode is ready to accept prompts.
 *
 * `/health` returns `healthy: true` as soon as the HTTP server binds, but the
 * session/agent subsystems may still be loading. Calling `app.agents` forces
 * OpenCode to load its agent registry — if the registry isn't ready,
 * `session.promptAsync` would silently drop the message.
 *
 * Prefer `waitForOpencodeHealthy` for sandbox finalize and let the prompt
 * path enforce its own readiness (via `openOpencodeSession`). This stays
 * useful for paths that bypass `openOpencodeSession` (e.g. the AI service
 * uses raw `client.session.create` + `client.session.prompt`).
 */
export async function waitForOpencodeReady(
  ipAddress: string,
  password?: string,
  timeout = OPENCODE_HEALTH_TIMEOUT_MS,
): Promise<void> {
  await pollOpencode(ipAddress, password, timeout, isOpencodeReady);
}

type OpencodeClient = ReturnType<typeof createOpencodeClient>;

async function pollOpencode(
  ipAddress: string,
  password: string | undefined,
  timeout: number,
  predicate: (client: OpencodeClient) => Promise<boolean>,
): Promise<void> {
  const startTime = Date.now();
  const url = `http://${ipAddress}:${config.ports.opencode}`;
  const client = createOpencodeClient({
    baseUrl: url,
    headers: buildOpenCodeAuthHeaders(password),
  });
  let delay = POLL_INITIAL_DELAY_MS;

  while (Date.now() - startTime < timeout) {
    if (await predicate(client)) return;
    await Bun.sleep(delay);
    delay = Math.min(delay * 2, POLL_MAX_DELAY_MS);
  }

  throw new Error("OpenCode server did not become ready within timeout");
}

async function isOpencodeHealthy(client: OpencodeClient): Promise<boolean> {
  try {
    const { data } = await client.global.health();
    return data?.healthy === true;
  } catch {
    return false;
  }
}

async function isOpencodeReady(client: OpencodeClient): Promise<boolean> {
  if (!(await isOpencodeHealthy(client))) return false;
  try {
    const { data, error } = await client.app.agents();
    return Boolean(!error && data);
  } catch {
    return false;
  }
}
