import { PATHS } from "@frak/atelier-shared/constants";
import { $ } from "bun";
import { Elysia } from "elysia";
import {
  sandboxService,
  systemPrebuildRunner,
  systemSandboxService,
} from "../container.ts";
import { networkService } from "../infrastructure/network/index.ts";
import {
  proxyService,
  SshPiperService,
} from "../infrastructure/proxy/index.ts";
import { StorageService } from "../infrastructure/storage/index.ts";
import { SYSTEM_WORKSPACE_ID } from "../modules/system-sandbox/index.ts";
import {
  type CleanupResult,
  CleanupResultSchema,
  StorageStatusSchema,
  SystemSandboxStatusSchema,
  type SystemStats,
  SystemStatsSchema,
} from "../schemas/index.ts";
import { config, isMock } from "../shared/lib/config.ts";
import { createChildLogger } from "../shared/lib/logger.ts";

const log = createChildLogger("system-routes");
const startTime = Date.now();

async function getSystemStats(): Promise<SystemStats> {
  if (isMock()) {
    const mockRunning = sandboxService
      .getByStatus("running")
      .filter((s) => s.workspaceId !== SYSTEM_WORKSPACE_ID);
    return {
      cpuUsage: 25,
      memoryUsed: 4 * 1024 * 1024 * 1024,
      memoryTotal: 16 * 1024 * 1024 * 1024,
      memoryPercent: 25,
      diskUsed: 50 * 1024 * 1024 * 1024,
      diskTotal: 500 * 1024 * 1024 * 1024,
      diskPercent: 10,
      activeSandboxes: mockRunning.length,
      maxSandboxes: config.server.maxSandboxes,
      uptime: Math.floor((Date.now() - startTime) / 1000),
    };
  }

  const [cpuResult, memResult, diskResult] = await Promise.all([
    $`top -bn1 | grep "Cpu(s)" | awk '{print $2}' | cut -d'%' -f1`
      .quiet()
      .nothrow(),
    $`free -b | grep Mem`.quiet().nothrow(),
    $`df -B1 / | tail -1`.quiet().nothrow(),
  ]);

  const cpuUsage = Number.parseFloat(cpuResult.stdout.toString().trim()) || 0;

  const memParts = memResult.stdout.toString().trim().split(/\s+/);
  const memoryTotal = Number.parseInt(memParts[1] || "0", 10);
  const memoryUsed = Number.parseInt(memParts[2] || "0", 10);

  const diskParts = diskResult.stdout.toString().trim().split(/\s+/);
  const diskTotal = Number.parseInt(diskParts[1] || "0", 10);
  const diskUsed = Number.parseInt(diskParts[2] || "0", 10);

  const allRunning = sandboxService.getByStatus("running");
  const userRunning = allRunning.filter(
    (s) => s.workspaceId !== SYSTEM_WORKSPACE_ID,
  );

  return {
    cpuUsage,
    memoryUsed,
    memoryTotal,
    memoryPercent: memoryTotal > 0 ? (memoryUsed / memoryTotal) * 100 : 0,
    diskUsed,
    diskTotal,
    diskPercent: diskTotal > 0 ? (diskUsed / diskTotal) * 100 : 0,
    activeSandboxes: userRunning.length,
    maxSandboxes: config.server.maxSandboxes,
    uptime: Math.floor((Date.now() - startTime) / 1000),
  };
}

async function performCleanup(): Promise<CleanupResult> {
  log.info("Starting system cleanup");

  let socketsRemoved = 0;
  let overlaysRemoved = 0;
  let tapDevicesRemoved = 0;
  let lvmVolumesRemoved = 0;
  let logsRemoved = 0;
  let caddyRoutesRemoved = 0;
  let sshRoutesRemoved = 0;
  const spaceFreed = 0;

  if (!isMock()) {
    const knownSandboxIds = new Set(sandboxService.getAll().map((s) => s.id));

    // Build a set of realpath targets for known sandbox vsock files so we
    // never delete a symlink target that a running sandbox still references
    // (covers pre-fix sandboxes that still use the old symlink approach).
    const protectedRealPaths = new Set<string>();
    for (const sid of knownSandboxIds) {
      const vsockFile = `${PATHS.SOCKET_DIR}/${sid}.vsock`;
      const resolved = await $`realpath ${vsockFile} 2>/dev/null`
        .quiet()
        .nothrow();
      const resolvedPath = resolved.stdout.toString().trim();
      if (resolved.exitCode === 0 && resolvedPath) {
        protectedRealPaths.add(resolvedPath);
      }
    }

    const orphanSocketResult =
      await $`find ${PATHS.SOCKET_DIR} -maxdepth 1 \( -name "*.sock" -o -name "*.vsock" -o -name "*.pid" \) 2>/dev/null`
        .quiet()
        .nothrow();
    const socketFiles = orphanSocketResult.stdout
      .toString()
      .trim()
      .split("\n")
      .filter(Boolean);
    for (const file of socketFiles) {
      const basename = file.split("/").pop() || "";
      const sandboxId = basename.replace(/\.(sock|vsock|pid)$/, "");
      if (!knownSandboxIds.has(sandboxId)) {
        if (protectedRealPaths.has(file)) continue;
        await $`rm -f ${file}`.quiet().nothrow();
        socketsRemoved++;
      }
    }

    const orphanLogResult =
      await $`find ${PATHS.LOG_DIR} -maxdepth 1 -name "*.log" 2>/dev/null`
        .quiet()
        .nothrow();
    const logFiles = orphanLogResult.stdout
      .toString()
      .trim()
      .split("\n")
      .filter(Boolean);
    for (const file of logFiles) {
      const basename = file.split("/").pop() || "";
      const sandboxId = basename.replace(/\.log$/, "");
      if (!knownSandboxIds.has(sandboxId)) {
        await $`rm -f ${file}`.quiet().nothrow();
        logsRemoved++;
      }
    }

    const overlayResult =
      await $`find ${PATHS.OVERLAY_DIR} -maxdepth 1 -name "*.ext4" 2>/dev/null`
        .quiet()
        .nothrow();
    const overlayFiles = overlayResult.stdout
      .toString()
      .trim()
      .split("\n")
      .filter(Boolean);
    for (const file of overlayFiles) {
      const basename = file.split("/").pop() || "";
      const sandboxId = basename.replace(/\.ext4$/, "");
      if (!knownSandboxIds.has(sandboxId)) {
        log.info({ file }, "Removing orphaned overlay file");
        await $`rm -f ${file}`.quiet().nothrow();
        overlaysRemoved++;
      }
    }

    const tapDevices = await networkService.listTapDevices();
    for (const tap of tapDevices) {
      const sandboxId = tap.replace("tap-", "");
      const matchingSandbox = sandboxService
        .getAll()
        .find((s) => s.id.startsWith(sandboxId));
      if (!matchingSandbox) {
        await networkService.deleteTap(tap);
        tapDevicesRemoved++;
      }
    }

    if (await StorageService.isAvailable()) {
      const lvmVolumes = await StorageService.listSandboxVolumes();
      for (const vol of lvmVolumes) {
        if (!knownSandboxIds.has(vol.name)) {
          log.info({ volumeName: vol.name }, "Removing orphaned LVM volume");
          await StorageService.deleteSandboxVolume(vol.name);
          lvmVolumesRemoved++;
        }
      }
    }

    const domains = await proxyService.getRegisteredDomains();
    for (const domain of domains) {
      const sandboxIdMatch = [...knownSandboxIds].find((sid: string) =>
        domain.endsWith(`${sid}.${config.domain.baseDomain}`),
      );
      if (!sandboxIdMatch) {
        if (domain.endsWith(`.${config.domain.baseDomain}`)) {
          await proxyService.removeRoute(domain);
          caddyRoutesRemoved++;
        }
      }
    }

    const sshSandboxIds = await SshPiperService.listRouteSandboxIds();
    for (const sshId of sshSandboxIds) {
      if (!knownSandboxIds.has(sshId)) {
        await SshPiperService.removeRoute(sshId);
        sshRoutesRemoved++;
      }
    }
  }

  // Reconcile IP pool — rebuild from DB to fix any stale allocations
  const activeIps = sandboxService.getAll().map((s) => s.runtime.ipAddress);
  networkService.reconcile(activeIps);

  log.info(
    {
      socketsRemoved,
      overlaysRemoved,
      tapDevicesRemoved,
      lvmVolumesRemoved,
      logsRemoved,
      caddyRoutesRemoved,
      sshRoutesRemoved,
    },
    "Cleanup completed",
  );

  return {
    socketsRemoved,
    overlaysRemoved,
    tapDevicesRemoved,
    lvmVolumesRemoved,
    logsRemoved,
    caddyRoutesRemoved,
    sshRoutesRemoved,
    spaceFreed,
  };
}

export const systemRoutes = new Elysia({ prefix: "/system" })
  .get(
    "/stats",
    async () => {
      return getSystemStats();
    },
    {
      response: SystemStatsSchema,
      detail: { tags: ["system"] },
    },
  )
  .get(
    "/storage",
    async () => {
      const [available, hasDefaultImage, pool] = await Promise.all([
        StorageService.isAvailable(),
        StorageService.hasImageVolume("dev-base"),
        StorageService.getPoolStats(),
      ]);

      return {
        available,
        hasDefaultImage,
        pool,
      };
    },
    {
      response: StorageStatusSchema,
      detail: { tags: ["system"] },
    },
  )
  .get(
    "/sandbox",
    async () => {
      const status = systemSandboxService.getStatus();
      const meta = await systemPrebuildRunner.readMetadata();
      return {
        ...status,
        prebuild: {
          exists:
            (await systemPrebuildRunner.hasPrebuild(SYSTEM_WORKSPACE_ID)) &&
            (await systemPrebuildRunner.hasVmSnapshot(SYSTEM_WORKSPACE_ID)),
          building: systemPrebuildRunner.isBuilding(),
          builtAt: meta?.builtAt ?? null,
        },
      };
    },
    {
      response: SystemSandboxStatusSchema,
      detail: { tags: ["system"] },
    },
  )
  .post(
    "/sandbox/prebuild",
    async () => {
      if (systemPrebuildRunner.isBuilding()) {
        return { started: false, message: "Prebuild already in progress" };
      }
      systemPrebuildRunner.runInBackground();
      return { started: true, message: "System prebuild started" };
    },
    {
      detail: { tags: ["system"] },
    },
  )
  .post(
    "/sandbox/prebuild/cancel",
    async () => {
      if (!systemPrebuildRunner.isBuilding()) {
        return { cancelled: false, message: "No prebuild in progress" };
      }
      await systemPrebuildRunner.cancel();
      return { cancelled: true, message: "System prebuild cancelled" };
    },
    {
      detail: { tags: ["system"] },
    },
  )
  .delete(
    "/sandbox/prebuild",
    async ({ set }) => {
      if (systemPrebuildRunner.isBuilding()) {
        set.status = 409;
        return { message: "Cannot delete while prebuild is in progress" };
      }
      await systemPrebuildRunner.delete();
      set.status = 204;
      return null;
    },
    {
      detail: { tags: ["system"] },
    },
  )
  .post(
    "/sandbox/start",
    async () => {
      const status = systemSandboxService.getStatus();
      if (status.status === "booting") {
        return {
          success: false,
          message: "System sandbox is already booting",
        };
      }
      if (status.status === "running" || status.status === "idle") {
        return {
          success: true,
          message: "System sandbox is already running",
        };
      }
      await systemSandboxService.ensureRunning();
      return { success: true, message: "System sandbox started" };
    },
    {
      detail: { tags: ["system"] },
    },
  )
  .post(
    "/sandbox/stop",
    async () => {
      const status = systemSandboxService.getStatus();
      if (status.status === "off") {
        return {
          success: true,
          message: "System sandbox is already off",
        };
      }
      if (status.status === "booting") {
        return {
          success: false,
          message: "Cannot stop while booting",
        };
      }
      await systemSandboxService.dispose();
      return { success: true, message: "System sandbox stopped" };
    },
    {
      detail: { tags: ["system"] },
    },
  )
  .post(
    "/sandbox/restart",
    async () => {
      const status = systemSandboxService.getStatus();
      if (status.status === "booting") {
        return {
          success: false,
          message: "Cannot restart while booting",
        };
      }
      if (status.status === "running" || status.status === "idle") {
        await systemSandboxService.dispose();
      }
      await systemSandboxService.ensureRunning();
      return { success: true, message: "System sandbox restarted" };
    },
    {
      detail: { tags: ["system"] },
    },
  )
  .post(
    "/cleanup",
    async () => {
      return performCleanup();
    },
    {
      response: CleanupResultSchema,
      detail: { tags: ["system"] },
    },
  );
