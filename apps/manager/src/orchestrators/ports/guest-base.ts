import { VM } from "@frak/atelier-shared/constants";
import type { AgentClient } from "../../infrastructure/agent/agent.client.ts";
import type {
  Command,
  FileWrite,
} from "../../infrastructure/agent/agent.types.ts";
import {
  SharedStorageService,
  StorageService,
} from "../../infrastructure/storage/index.ts";
import { config } from "../../shared/lib/config.ts";
import { createChildLogger } from "../../shared/lib/logger.ts";

const log = createChildLogger("guest-base");

// --- Pure command builders ---

export function buildDnsCommand(): Command {
  const dnsServers = config.network.dnsServers;
  const dnsCommands = dnsServers
    .map((dns) => `echo 'nameserver ${dns}' >> /etc/resolv.conf`)
    .join(" && ");
  return {
    id: "dns",
    command: `> /etc/resolv.conf && ${dnsCommands}`,
    timeout: 5000,
  };
}

export function buildClockSyncCommand(): Command {
  return {
    id: "clock-sync",
    command:
      "pkill chronyd 2>/dev/null; chronyd -f /etc/chrony/chrony.conf 2>/dev/null || true",
    timeout: 5000,
  };
}

export function buildHostnameCommand(hostname: string): Command {
  return {
    id: "hostname",
    command: `hostname "${hostname}" && echo "${hostname}" > /etc/hostname`,
    timeout: 5000,
  };
}

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

export async function buildSwapCommand(useLvm = true): Promise<Command | null> {
  if (!useLvm || !(await StorageService.isAvailable())) return null;
  return {
    id: "setup-swap",
    command: "/etc/sandbox/setup-swap.sh",
    timeout: 30000,
  };
}

export async function buildMountSharedBinariesCommand(): Promise<Command | null> {
  const imageInfo = await SharedStorageService.getBinariesImageInfo();
  if (!imageInfo.exists) return null;
  return {
    id: "mount-shared",
    command:
      "mountpoint -q /opt/shared || { mknod -m 444 /dev/vdb b 254 16 2>/dev/null; mkdir -p /opt/shared && mount -o ro /dev/vdb /opt/shared; }",
    timeout: 5000,
  };
}

// --- True executors (can't be batched) ---

export async function resizeStorage(
  agent: AgentClient,
  sandboxId: string,
): Promise<{
  success: boolean;
  disk?: { total: number; used: number; free: number };
  error?: string;
}> {
  try {
    const result = await agent.exec(
      sandboxId,
      [
        "test -e /dev/vda || mknod /dev/vda b 254 0",
        "resize2fs /dev/vda",
        "df -B1 / | tail -1",
      ].join(" && "),
      { timeout: 60000 },
    );

    if (result.exitCode !== 0) {
      return { success: false, error: result.stderr };
    }

    const lastLine = result.stdout.split("\n").pop() ?? "";
    const [, total, used, free] = lastLine.split(/\s+/);
    return {
      success: true,
      disk: {
        total: parseInt(total || "0", 10),
        used: parseInt(used || "0", 10),
        free: parseInt(free || "0", 10),
      },
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

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
