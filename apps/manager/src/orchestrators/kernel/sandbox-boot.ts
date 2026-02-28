import { DEFAULTS, LVM } from "@frak/atelier-shared/constants";
import { customAlphabet } from "nanoid";
import { eventBus } from "../../infrastructure/events/index.ts";
import {
  configureVm,
  getSandboxPaths,
  launchFirecracker,
  type SandboxPaths,
} from "../../infrastructure/firecracker/index.ts";
import {
  type NetworkAllocation,
  networkService,
} from "../../infrastructure/network/index.ts";
import {
  proxyService,
  SshPiperService,
} from "../../infrastructure/proxy/index.ts";
import { StorageService } from "../../infrastructure/storage/index.ts";
import type { Sandbox } from "../../schemas/index.ts";
import { config } from "../../shared/lib/config.ts";
import { createChildLogger } from "../../shared/lib/logger.ts";
import type { SandboxPorts } from "../ports/sandbox-ports.ts";
import { waitForBoot } from "./boot-waiter.ts";
import { cleanupSandboxResources } from "./cleanup-coordinator.ts";

const log = createChildLogger("sandbox-boot");

const generatePassword = customAlphabet(
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789",
);

/* ------------------------------------------------------------------ */
/*  Types                                                             */
/* ------------------------------------------------------------------ */

export interface BootNewOptions {
  workspaceId?: string;
  system?: boolean;
  baseImage?: string;
  vcpus: number;
  memoryMb: number;
  prebuildReady: boolean;
}

export interface BootResult {
  sandbox: Sandbox;
  pid: number;
  paths: SandboxPaths;
  network: NetworkAllocation;
  usedPrebuild: boolean;
}

export interface RestartResult {
  pid: number;
  paths: SandboxPaths;
  agentReady: boolean;
}

/* ------------------------------------------------------------------ */
/*  Boot a brand-new sandbox (create flow)                            */
/* ------------------------------------------------------------------ */

export async function bootNewSandbox(
  sandboxId: string,
  options: BootNewOptions,
  ports: SandboxPorts,
): Promise<BootResult> {
  // Track allocated resources for rollback on failure
  let network: NetworkAllocation | undefined;
  let volumePaths: SandboxPaths | undefined;
  let pid: number | undefined;

  try {
    // 1. Check prebuild availability
    let usedPrebuild = false;
    if (options.workspaceId && (options.system || options.prebuildReady)) {
      usedPrebuild = await StorageService.hasPrebuild(options.workspaceId);
    }

    // 2. Allocate network + create volume + create TAP in parallel
    const [networkAlloc, volume] = await Promise.all([
      networkService.allocate(sandboxId),
      createVolume(sandboxId, options, usedPrebuild),
      networkService.createTap(`tap-${sandboxId.slice(0, 8)}`),
    ]);
    network = networkAlloc;
    volumePaths = volume.paths;

    // 3. Resize volume before boot if needed
    await resizeVolumeBeforeBoot(sandboxId, volumePaths, usedPrebuild);

    // 4. Initialize sandbox record
    const opencodePassword = generatePassword(32);
    const sandbox: Sandbox = {
      id: sandboxId,
      status: "creating",
      workspaceId: options.workspaceId,
      runtime: {
        ipAddress: network.ipAddress,
        macAddress: network.macAddress,
        urls: { vscode: "", opencode: "", ssh: "" },
        vcpus: options.vcpus,
        memoryMb: options.memoryMb,
        opencodePassword,
      },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    ports.sandbox.create(sandbox);
    log.info({ sandboxId }, "Sandbox initialized");

    // 5. Launch Firecracker
    const launch = await launchFirecracker(volumePaths);
    pid = launch.pid;
    log.debug({ sandboxId, pid }, "Firecracker process started");

    // 6. Configure VM
    await configureVm(launch.client, {
      paths: volumePaths,
      macAddress: network.macAddress,
      tapDevice: network.tapDevice,
      vcpus: options.vcpus,
      memoryMb: options.memoryMb,
      ipAddress: network.ipAddress,
      gateway: network.gateway,
    });
    log.debug({ sandboxId }, "VM configured");

    // 7. Boot + wait for agent
    await launch.client.start();
    const [, agentReady] = await Promise.all([
      waitForBoot(launch.client),
      ports.agent.waitForAgent(sandboxId, {
        timeout: 60000,
      }),
    ]);
    if (!agentReady) {
      log.warn({ sandboxId }, "Agent did not become ready");
    }
    log.debug({ sandboxId }, "VM booted and agent ready");

    return {
      sandbox,
      pid,
      paths: volumePaths,
      network,
      usedPrebuild,
    };
  } catch (error) {
    log.error(
      {
        sandboxId,
        error: error instanceof Error ? error.message : error,
      },
      "Boot failed, cleaning up allocated resources",
    );
    await cleanupSandboxResources(sandboxId, {
      pid,
      paths: volumePaths,
      network,
    });
    throw error;
  }
}

/* ------------------------------------------------------------------ */
/*  Boot an existing sandbox (restart flow)                           */
/* ------------------------------------------------------------------ */

export async function bootExistingSandbox(
  sandboxId: string,
  sandbox: Sandbox,
  ports: SandboxPorts,
): Promise<RestartResult> {
  const volumeInfo = await StorageService.getVolumeInfo(sandboxId);
  if (!volumeInfo) {
    throw new Error(
      `Cannot start sandbox '${sandboxId}': LVM volume not found.`,
    );
  }

  const volumePath = `/dev/${LVM.VG_NAME}/${LVM.SANDBOX_PREFIX}${sandboxId}`;
  const paths = getSandboxPaths(sandboxId, volumePath);
  const tapDevice = `tap-${sandboxId.slice(0, 8)}`;
  await networkService.createTap(tapDevice);

  const { pid, client } = await launchFirecracker(paths);
  log.debug({ sandboxId, pid }, "Firecracker process started");

  await configureVm(client, {
    paths,
    macAddress: sandbox.runtime.macAddress,
    tapDevice,
    vcpus: sandbox.runtime.vcpus,
    memoryMb: sandbox.runtime.memoryMb,
    ipAddress: sandbox.runtime.ipAddress,
    gateway: config.network.bridgeIp,
  });
  log.debug({ sandboxId }, "VM configured");

  await client.start();
  await waitForBoot(client);
  log.debug({ sandboxId }, "VM booted");

  const agentReady = await ports.agent.waitForAgent(sandboxId, {
    timeout: 60000,
  });
  if (!agentReady) {
    log.warn({ sandboxId }, "Agent did not become ready after restart");
  }

  return { pid, paths, agentReady };
}

/* ------------------------------------------------------------------ */
/*  Finalize: register routes + update status (create flow)           */
/* ------------------------------------------------------------------ */

export async function finalizeNewSandbox(
  sandboxId: string,
  sandbox: Sandbox,
  network: NetworkAllocation,
  pid: number,
  ports: SandboxPorts,
  options: { system?: boolean },
): Promise<Sandbox> {
  const sshCmd = await SshPiperService.registerRoute(
    sandboxId,
    network.ipAddress,
    ports.sshKeys.getValidPublicKeys(),
  );

  let urls: { vscode: string; opencode: string; ssh: string };

  if (options.system) {
    const opencodeUrl = await proxyService.registerOpenCodeRoute(
      sandboxId,
      network.ipAddress,
      config.advanced.vm.opencode.port,
    );
    urls = { vscode: "", opencode: opencodeUrl, ssh: sshCmd };
  } else {
    const routeUrls = await proxyService.registerRoutes(
      sandboxId,
      network.ipAddress,
      {
        vscode: config.advanced.vm.vscode.port,
        opencode: config.advanced.vm.opencode.port,
      },
    );
    urls = { ...routeUrls, ssh: sshCmd };
  }

  sandbox.status = "running";
  sandbox.runtime.pid = pid;
  sandbox.runtime.urls = urls;

  ports.sandbox.update(sandboxId, sandbox);
  eventBus.emit({
    type: "sandbox.created",
    properties: {
      id: sandboxId,
      workspaceId: sandbox.workspaceId,
    },
  });

  log.info(
    { sandboxId, pid, useLvm: sandbox.runtime },
    "Sandbox created successfully",
  );
  return sandbox;
}

/* ------------------------------------------------------------------ */
/*  Finalize: register routes + update status (restart flow)          */
/* ------------------------------------------------------------------ */

export async function finalizeRestartedSandbox(
  sandboxId: string,
  sandbox: Sandbox,
  pid: number,
  ports: SandboxPorts,
  options: { system?: boolean },
): Promise<Sandbox> {
  if (options.system) {
    await proxyService.registerOpenCodeRoute(
      sandboxId,
      sandbox.runtime.ipAddress,
      config.advanced.vm.opencode.port,
    );
  } else {
    await proxyService.registerRoutes(sandboxId, sandbox.runtime.ipAddress, {
      vscode: config.advanced.vm.vscode.port,
      opencode: config.advanced.vm.opencode.port,
    });
  }

  const updatedSandbox: Sandbox = {
    ...sandbox,
    status: "running",
    runtime: { ...sandbox.runtime, pid },
    updatedAt: new Date().toISOString(),
  };

  ports.sandbox.update(sandboxId, updatedSandbox);
  eventBus.emit({
    type: "sandbox.updated",
    properties: { id: sandboxId, status: "running" },
  });
  log.info({ sandboxId, pid }, "Sandbox started");

  return updatedSandbox;
}

/* ------------------------------------------------------------------ */
/*  Internal helpers                                                  */
/* ------------------------------------------------------------------ */

async function createVolume(
  sandboxId: string,
  options: BootNewOptions,
  usedPrebuild: boolean,
): Promise<{ paths: SandboxPaths }> {
  const baseImage = options.baseImage;
  const lvmAvailable = await StorageService.isAvailable();

  let lvmVolumePath: string | undefined;
  if (lvmAvailable) {
    lvmVolumePath = await StorageService.createSandboxVolume(sandboxId, {
      workspaceId: options.workspaceId,
      baseImage,
      usePrebuild: usedPrebuild,
    });
  }

  const paths = getSandboxPaths(sandboxId, lvmVolumePath);
  log.debug(
    { sandboxId, useLvm: paths.useLvm, usedPrebuild },
    "Volume created",
  );

  return { paths };
}

async function resizeVolumeBeforeBoot(
  sandboxId: string,
  paths: SandboxPaths,
  usedPrebuild: boolean,
): Promise<void> {
  if (!paths.useLvm) return;
  if (usedPrebuild) {
    log.debug({ sandboxId }, "Skipping volume resize (using prebuild)");
    return;
  }

  const targetSizeGb = DEFAULTS.VOLUME_SIZE_GB;

  try {
    const currentSize = await StorageService.getVolumeSizeBytes(sandboxId);
    const targetSizeBytes = targetSizeGb * 1024 * 1024 * 1024;

    if (currentSize >= targetSizeBytes) {
      log.debug(
        {
          sandboxId,
          currentSizeGb: Math.round(currentSize / 1024 / 1024 / 1024),
        },
        "Volume already at target size",
      );
      return;
    }

    const result = await StorageService.resizeSandboxVolume(
      sandboxId,
      targetSizeGb,
    );

    if (result.success) {
      log.info(
        {
          sandboxId,
          previousSizeGb: Math.round(result.previousSize / 1024 / 1024 / 1024),
          newSizeGb: targetSizeGb,
        },
        "Volume resized before boot",
      );
    } else {
      log.warn(
        { sandboxId, error: result.error },
        "Failed to resize volume before boot",
      );
    }
  } catch (error) {
    log.warn(
      { sandboxId, error },
      "Volume resize failed, continuing with original size",
    );
  }
}
