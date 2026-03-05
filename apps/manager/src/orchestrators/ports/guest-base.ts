import { VM } from "@frak/atelier-shared/constants";
import type { AgentClient } from "../../infrastructure/agent/agent.client.ts";
import type { FileWrite } from "../../infrastructure/agent/agent.types.ts";
import { createChildLogger } from "../../shared/lib/logger.ts";

const log = createChildLogger("guest-base");

// --- Pure command builders ---

// --- Pure file builders ---

export function buildRuntimeEnvFiles(env: Record<string, string>): FileWrite[] {
  const content = `${Object.entries(env)
    .map(([k, v]) => `export ${k}=${JSON.stringify(v)}`)
    .join("\n")}\n`;
  return [
    {
      path: "/etc/sandbox/runtime.env",
      content,
      mode: "0644",
      owner: "root",
    },
    {
      path: "/etc/profile.d/98-atelier-runtime.sh",
      content:
        "[ -r /etc/sandbox/runtime.env ] && . /etc/sandbox/runtime.env\n",
      owner: "root",
    },
  ];
}

export function buildOhMyOpenCodeCacheFiles(providers: string[]): FileWrite[] {
  return [
    {
      path: `${VM.HOME}/.cache/oh-my-opencode/connected-providers.json`,
      content: JSON.stringify(
        { connected: providers, updatedAt: new Date().toISOString() },
        null,
        2,
      ),
      owner: "dev",
    },
  ];
}

export function buildSandboxMdFile(content: string): FileWrite[] {
  return [{ path: `${VM.HOME}/SANDBOX.md`, content, owner: "dev" }];
}

// --- Async command builders (host-side check → Command | null) ---

// --- True executors (can't be batched) ---

export async function startServices(
  agent: AgentClient,
  sandboxId: string,
  serviceNames: string[],
): Promise<void> {
  await Promise.all(
    serviceNames.map((name) =>
      agent.serviceStart(sandboxId, name).catch((err) => {
        log.warn(
          { sandboxId, service: name, error: String(err) },
          "Service start failed (non-blocking)",
        );
      }),
    ),
  );
  log.info({ sandboxId, services: serviceNames }, "Services started");
}
