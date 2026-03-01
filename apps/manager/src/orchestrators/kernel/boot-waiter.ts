import { createOpencodeClient } from "@opencode-ai/sdk/v2";
import { $ } from "bun";
import type { FirecrackerClient } from "../../infrastructure/firecracker/index.ts";
import { config } from "../../shared/lib/config.ts";
import { createChildLogger } from "../../shared/lib/logger.ts";
import { buildOpenCodeAuthHeaders } from "../../shared/lib/opencode-auth.ts";

const log = createChildLogger("boot-waiter");

const OPENCODE_HEALTH_TIMEOUT_MS = 120000;

export async function waitForBoot(
  client: FirecrackerClient,
  options: { pid?: number; logPath?: string; timeoutMs?: number } = {},
): Promise<void> {
  const { pid, logPath, timeoutMs = 30000 } = options;
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (pid) {
      const alive = await $`kill -0 ${pid}`.quiet().nothrow();
      if (alive.exitCode !== 0) {
        const lastLines = await readLogTail(logPath);
        throw new Error(`Firecracker process died during boot:\n${lastLines}`);
      }
    }

    try {
      if (await client.isRunning()) return;
    } catch {}
    await Bun.sleep(50);
  }

  const lastLines = await readLogTail(logPath);
  if (lastLines) {
    log.warn({ pid }, "Boot timed out \u2014 collecting FC logs");
    throw new Error(`VM boot timeout after ${timeoutMs}ms:\n${lastLines}`);
  }

  throw new Error(`VM boot timeout after ${timeoutMs}ms`);
}

async function readLogTail(logPath?: string): Promise<string> {
  if (!logPath) return "";
  try {
    const content = await Bun.file(logPath).text();
    return content.split("\n").slice(-20).join("\n");
  } catch {
    return "";
  }
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
