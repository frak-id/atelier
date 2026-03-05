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

export async function waitForOpencode(
  ipAddress: string,
  password?: string,
  timeout = OPENCODE_HEALTH_TIMEOUT_MS,
): Promise<void> {
  const startTime = Date.now();
  const url = `http://${ipAddress}:${config.ports.opencode}`;
  let delay = 250;

  while (Date.now() - startTime < timeout) {
    try {
      const client = createOpencodeClient({
        baseUrl: url,
        headers: buildOpenCodeAuthHeaders(password),
      });
      const { data } = await client.global.health();
      if (data?.healthy) {
        return;
      }
    } catch {}

    await Bun.sleep(delay);
    delay = Math.min(delay * 2, 2000);
  }

  throw new Error("OpenCode server did not become healthy within timeout");
}
