import type { CleanupResult, SystemStats } from "@frak-sandbox/shared/types";
import { config } from "../../lib/config.ts";
import { createChildLogger } from "../../lib/logger.ts";
import { dirExists, exec } from "../../lib/shell.ts";
import { NetworkService } from "../../services/network.ts";
import { sandboxStore } from "../../state/store.ts";

const log = createChildLogger("system");
const startTime = Date.now();

export const SystemService = {
  async getStats(): Promise<SystemStats> {
    if (config.isMock()) {
      return {
        cpuUsage: 15.5,
        memoryUsed: 8 * 1024 * 1024 * 1024,
        memoryTotal: 64 * 1024 * 1024 * 1024,
        memoryPercent: 12.5,
        diskUsed: 100 * 1024 * 1024 * 1024,
        diskTotal: 1024 * 1024 * 1024 * 1024,
        diskPercent: 9.8,
        activeSandboxes: sandboxStore.countByStatus("running"),
        maxSandboxes: config.defaults.MAX_SANDBOXES,
        uptime: Math.floor((Date.now() - startTime) / 1000),
      };
    }

    const [cpuUsage, memInfo, diskInfo] = await Promise.all([
      this.getCpuUsage(),
      this.getMemoryInfo(),
      this.getDiskInfo(),
    ]);

    return {
      cpuUsage,
      ...memInfo,
      ...diskInfo,
      activeSandboxes: sandboxStore.countByStatus("running"),
      maxSandboxes: config.defaults.MAX_SANDBOXES,
      uptime: Math.floor((Date.now() - startTime) / 1000),
    };
  },

  async getCpuUsage(): Promise<number> {
    const result = await exec(
      `top -bn1 | grep "Cpu(s)" | sed "s/.*, *\\([0-9.]*\\)%* id.*/\\1/" | awk '{print 100 - $1}'`,
      { throws: false },
    );
    return Number.parseFloat(result.stdout) || 0;
  },

  async getMemoryInfo(): Promise<{
    memoryUsed: number;
    memoryTotal: number;
    memoryPercent: number;
  }> {
    const result = await exec(`free -b | awk '/Mem:/ {print $2, $3}'`, {
      throws: false,
    });
    const [total, used] = result.stdout.split(" ").map(Number);
    const memoryTotal = total || 0;
    const memoryUsed = used || 0;
    const memoryPercent =
      memoryTotal > 0 ? (memoryUsed / memoryTotal) * 100 : 0;

    return { memoryUsed, memoryTotal, memoryPercent };
  },

  async getDiskInfo(): Promise<{
    diskUsed: number;
    diskTotal: number;
    diskPercent: number;
  }> {
    const result = await exec(
      `df -B1 ${config.paths.SANDBOX_DIR} 2>/dev/null | awk 'NR==2 {print $2, $3}'`,
      { throws: false },
    );
    const [total, used] = result.stdout.split(" ").map(Number);
    const diskTotal = total || 0;
    const diskUsed = used || 0;
    const diskPercent = diskTotal > 0 ? (diskUsed / diskTotal) * 100 : 0;

    return { diskUsed, diskTotal, diskPercent };
  },

  async cleanup(): Promise<CleanupResult> {
    log.info("Starting system cleanup");

    const result: CleanupResult = {
      socketsRemoved: 0,
      overlaysRemoved: 0,
      tapDevicesRemoved: 0,
      spaceFreed: 0,
    };

    if (config.isMock()) {
      return result;
    }

    const activeSandboxIds = new Set(sandboxStore.getAll().map((s) => s.id));

    const socketCleanup = await this.cleanupOrphanedSockets(activeSandboxIds);
    result.socketsRemoved = socketCleanup.count;

    const overlayCleanup = await this.cleanupOrphanedOverlays(activeSandboxIds);
    result.overlaysRemoved = overlayCleanup.count;
    result.spaceFreed = overlayCleanup.spaceFreed;

    const tapCleanup = await this.cleanupOrphanedTaps(activeSandboxIds);
    result.tapDevicesRemoved = tapCleanup.count;

    log.info({ result }, "Cleanup completed");
    return result;
  },

  async cleanupOrphanedSockets(
    activeSandboxIds: Set<string>,
  ): Promise<{ count: number }> {
    if (!(await dirExists(config.paths.SOCKET_DIR))) {
      return { count: 0 };
    }

    const result = await exec(
      `ls ${config.paths.SOCKET_DIR}/*.sock 2>/dev/null | xargs -I{} basename {} .sock`,
      { throws: false },
    );

    const sockets = result.stdout.split("\n").filter(Boolean);
    let count = 0;

    for (const socketId of sockets) {
      if (!activeSandboxIds.has(socketId)) {
        await exec(
          `rm -f ${config.paths.SOCKET_DIR}/${socketId}.sock ${config.paths.SOCKET_DIR}/${socketId}.pid`,
        );
        count++;
      }
    }

    return { count };
  },

  async cleanupOrphanedOverlays(
    activeSandboxIds: Set<string>,
  ): Promise<{ count: number; spaceFreed: number }> {
    if (!(await dirExists(config.paths.OVERLAY_DIR))) {
      return { count: 0, spaceFreed: 0 };
    }

    const result = await exec(
      `ls ${config.paths.OVERLAY_DIR}/*.ext4 2>/dev/null | xargs -I{} basename {} .ext4`,
      { throws: false },
    );

    const overlays = result.stdout.split("\n").filter(Boolean);
    let count = 0;
    let spaceFreed = 0;

    for (const overlayId of overlays) {
      if (!activeSandboxIds.has(overlayId)) {
        const sizeResult = await exec(
          `stat -c%s ${config.paths.OVERLAY_DIR}/${overlayId}.ext4`,
          { throws: false },
        );
        spaceFreed += Number.parseInt(sizeResult.stdout, 10) || 0;
        await exec(`rm -f ${config.paths.OVERLAY_DIR}/${overlayId}.ext4`);
        count++;
      }
    }

    return { count, spaceFreed };
  },

  async cleanupOrphanedTaps(
    activeSandboxIds: Set<string>,
  ): Promise<{ count: number }> {
    const tapDevices = await NetworkService.listTapDevices();
    let count = 0;

    for (const tap of tapDevices) {
      const sandboxId = tap.replace(/^tap-/, "");
      const matchingSandbox = Array.from(activeSandboxIds).find((id) =>
        id.startsWith(sandboxId),
      );

      if (!matchingSandbox) {
        await NetworkService.deleteTap(tap);
        count++;
      }
    }

    return { count };
  },
};
