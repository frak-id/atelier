import type { SandboxConfig } from "@frak/atelier-shared";
import { VM } from "@frak/atelier-shared/constants";
import type { AgentClient } from "../../infrastructure/agent/index.ts";
import {
  SharedStorageService,
  StorageService,
} from "../../infrastructure/storage/index.ts";
import { config } from "../../shared/lib/config.ts";
import { createChildLogger } from "../../shared/lib/logger.ts";

const log = createChildLogger("guest-base");

export async function configureDns(
  agent: AgentClient,
  sandboxId: string,
): Promise<void> {
  const dnsServers = config.network.dnsServers;
  const dnsCommands = dnsServers
    .map((dns) => `echo 'nameserver ${dns}' >> /etc/resolv.conf`)
    .join(" && ");

  const cmd = `> /etc/resolv.conf && ${dnsCommands}`;
  const result = await agent.exec(sandboxId, cmd, {
    timeout: 5000,
  });

  if (result.exitCode !== 0) {
    log.warn(
      { sandboxId, exitCode: result.exitCode, stderr: result.stderr },
      "DNS configuration failed",
    );
    throw new Error(`DNS configuration failed: ${result.stderr}`);
  }

  log.debug({ sandboxId }, "DNS configured");
}

export async function syncClock(
  agent: AgentClient,
  sandboxId: string,
): Promise<void> {
  const cmd =
    "pkill chronyd 2>/dev/null; chronyd -f /etc/chrony/chrony.conf 2>/dev/null || true";
  const result = await agent.exec(sandboxId, cmd, {
    timeout: 5000,
  });

  if (result.exitCode !== 0) {
    log.warn(
      { sandboxId, exitCode: result.exitCode, stderr: result.stderr },
      "Clock sync failed (non-blocking)",
    );
  } else {
    log.debug({ sandboxId }, "chronyd started");
  }
}

export async function setHostname(
  agent: AgentClient,
  sandboxId: string,
  hostname: string,
): Promise<void> {
  const cmd = `hostname "${hostname}" && echo "${hostname}" > /etc/hostname`;
  const result = await agent.exec(sandboxId, cmd, {
    timeout: 5000,
  });

  if (result.exitCode !== 0) {
    log.warn(
      { sandboxId, exitCode: result.exitCode, stderr: result.stderr },
      "Failed to set hostname",
    );
  } else {
    log.debug({ sandboxId, hostname }, "Hostname set");
  }
}

export async function pushRuntimeEnv(
  agent: AgentClient,
  sandboxId: string,
  env: Record<string, string>,
): Promise<void> {
  const content = `${Object.entries(env)
    .map(([k, v]) => `export ${k}=${JSON.stringify(v)}`)
    .join("\n")}\n`;

  await agent.writeFiles(sandboxId, [
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
  ]);

  log.debug({ sandboxId, keys: Object.keys(env) }, "Runtime env pushed");
}

export async function pushSandboxConfig(
  agent: AgentClient,
  sandboxId: string,
  sandboxConfig: SandboxConfig,
): Promise<void> {
  await agent.setConfig(sandboxId, sandboxConfig);
  log.debug({ sandboxId }, "Sandbox config pushed via setConfig");
}

export async function pushOhMyOpenCodeCache(
  agent: AgentClient,
  sandboxId: string,
  providers: string[],
): Promise<void> {
  const cacheContent = JSON.stringify(
    {
      connected: providers,
      updatedAt: new Date().toISOString(),
    },
    null,
    2,
  );

  await agent.writeFiles(sandboxId, [
    {
      path: `${VM.HOME}/.cache/oh-my-opencode/connected-providers.json`,
      content: cacheContent,
      owner: "dev",
    },
  ]);

  log.debug({ sandboxId, providers }, "OhMyOpenCode cache pushed");
}

export async function pushSandboxMd(
  agent: AgentClient,
  sandboxId: string,
  content: string,
): Promise<void> {
  await agent.writeFiles(sandboxId, [
    {
      path: `${VM.HOME}/SANDBOX.md`,
      content,
      owner: "dev",
    },
  ]);

  log.debug({ sandboxId }, "SANDBOX.md pushed");
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

export async function setupSwap(
  agent: AgentClient,
  sandboxId: string,
  useLvm = true,
): Promise<void> {
  if (!useLvm || !(await StorageService.isAvailable())) {
    log.debug({ sandboxId }, "Skipping swap setup (no LVM)");
    return;
  }

  try {
    const result = await agent.exec(sandboxId, "/etc/sandbox/setup-swap.sh", {
      timeout: 30000,
    });

    if (result.exitCode === 0) {
      log.info(
        { sandboxId, output: result.stdout.trim() },
        "Swap setup completed",
      );
    } else {
      log.warn(
        { sandboxId, stderr: result.stderr },
        "Swap setup failed (non-critical)",
      );
    }
  } catch (error) {
    log.warn({ sandboxId, error }, "Swap setup failed (non-critical)");
  }
}

export async function mountSharedBinaries(
  agent: AgentClient,
  sandboxId: string,
): Promise<void> {
  const imageInfo = await SharedStorageService.getBinariesImageInfo();
  if (!imageInfo.exists) return;

  const mountResult = await agent.exec(
    sandboxId,
    "mountpoint -q /opt/shared || { mknod -m 444 /dev/vdb b 254 16 2>/dev/null; mkdir -p /opt/shared && mount -o ro /dev/vdb /opt/shared; }",
    { timeout: 5000 },
  );

  if (mountResult.exitCode === 0) {
    log.info({ sandboxId }, "Shared binaries mounted");
  } else {
    log.warn(
      { sandboxId, stderr: mountResult.stderr },
      "Failed to mount shared binaries",
    );
  }
}
