import { createOpencodeClient } from "@opencode-ai/sdk/v2";
import type { KubeClient } from "../../infrastructure/kubernetes/index.ts";
import { config } from "../../shared/lib/config.ts";
import { createChildLogger } from "../../shared/lib/logger.ts";
import { buildOpenCodeAuthHeaders } from "../../shared/lib/opencode-auth.ts";

const log = createChildLogger("boot-waiter");

const OPENCODE_HEALTH_TIMEOUT_MS = 120000;

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
 * Wait until the OpenCode server is fully ready to accept prompts.
 *
 * `/health` returns `healthy: true` as soon as the HTTP server binds, but the
 * session/agent subsystems may still be loading. Calling `app.agents` forces
 * OpenCode to load its agent registry — if the registry isn't ready,
 * `prompt_async` would silently drop the message. Waiting for both endpoints
 * gives a much stronger guarantee that subsequent prompts will be processed.
 */
export async function waitForOpencode(
  ipAddress: string,
  password?: string,
  timeout = OPENCODE_HEALTH_TIMEOUT_MS,
): Promise<void> {
  const startTime = Date.now();
  const url = `http://${ipAddress}:${config.ports.opencode}`;
  const client = createOpencodeClient({
    baseUrl: url,
    headers: buildOpenCodeAuthHeaders(password),
  });
  let delay = 250;

  while (Date.now() - startTime < timeout) {
    if (await isOpencodeReady(client)) {
      return;
    }

    await Bun.sleep(delay);
    delay = Math.min(delay * 2, 2000);
  }

  throw new Error("OpenCode server did not become ready within timeout");
}

async function isOpencodeReady(
  client: ReturnType<typeof createOpencodeClient>,
): Promise<boolean> {
  try {
    const { data: health } = await client.global.health();
    if (!health?.healthy) return false;

    // /health is just an HTTP liveness check — it doesn't certify the agent
    // registry is loaded. Verify by listing agents (the prompt path needs them).
    const { data: agents, error } = await client.app.agents();
    if (error || !agents) return false;
    return true;
  } catch {
    return false;
  }
}
