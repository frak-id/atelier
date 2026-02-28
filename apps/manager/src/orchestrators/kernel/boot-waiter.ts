import { createOpencodeClient } from "@opencode-ai/sdk/v2";
import type { FirecrackerClient } from "../../infrastructure/firecracker/index.ts";
import { config } from "../../shared/lib/config.ts";
import { buildOpenCodeAuthHeaders } from "../../shared/lib/opencode-auth.ts";

const OPENCODE_HEALTH_TIMEOUT_MS = 120000;

export async function waitForBoot(
  client: FirecrackerClient,
  timeoutMs = 30000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    try {
      if (await client.isRunning()) return;
    } catch {}
    await Bun.sleep(50);
  }

  throw new Error(`VM boot timeout after ${timeoutMs}ms`);
}

export async function waitForOpencode(
  ipAddress: string,
  password?: string,
  timeout = OPENCODE_HEALTH_TIMEOUT_MS,
): Promise<void> {
  const startTime = Date.now();
  const url = `http://${ipAddress}:${config.advanced.vm.opencode.port}`;
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
