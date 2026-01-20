import { LVM } from "@frak-sandbox/shared/constants";
import { $ } from "bun";
import { config } from "../../shared/lib/config.ts";
import { createChildLogger } from "../../shared/lib/logger.ts";

const log = createChildLogger("storage");

interface VolumeInfo {
  name: string;
  size: string;
  used: string;
  origin?: string;
}

interface PoolStats {
  exists: boolean;
  dataPercent: number;
  metadataPercent: number;
  totalSize: string;
  usedSize: string;
  volumeCount: number;
}

const vg = LVM.VG_NAME;
const thinPool = LVM.THIN_POOL;
const baseVolume = LVM.BASE_VOLUME;
const sandboxPrefix = LVM.SANDBOX_PREFIX;

const LVCREATE = "/usr/sbin/lvcreate";
const LVREMOVE = "/usr/sbin/lvremove";
const LVS = "/usr/sbin/lvs";
const prebuildPrefix = LVM.PREBUILD_PREFIX;

async function lvExists(volumePath: string): Promise<boolean> {
  const result = await $`${LVS} ${volumePath} --noheadings 2>/dev/null`
    .quiet()
    .nothrow();
  return result.exitCode === 0;
}

import type { BaseImageId } from "../../schemas/image.ts";
import { DEFAULT_BASE_IMAGE, getBaseImage } from "../../schemas/image.ts";

export const StorageService = {
  async isAvailable(): Promise<boolean> {
    if (config.isMock()) return true;

    const result = await $`test -x /usr/sbin/lvm`.quiet().nothrow();
    if (result.exitCode !== 0) return false;

    return lvExists(`${vg}/${thinPool}`);
  },

  async getPoolStats(): Promise<PoolStats> {
    if (config.isMock()) {
      return {
        exists: true,
        dataPercent: 15.5,
        metadataPercent: 2.1,
        totalSize: "500G",
        usedSize: "77.5G",
        volumeCount: 5,
      };
    }

    const available = await this.isAvailable();
    if (!available) {
      return {
        exists: false,
        dataPercent: 0,
        metadataPercent: 0,
        totalSize: "0",
        usedSize: "0",
        volumeCount: 0,
      };
    }

    const poolInfo =
      await $`${LVS} ${vg}/${thinPool} -o lv_size,data_percent,metadata_percent --noheadings --units g --nosuffix`
        .quiet()
        .nothrow();

    const volumeCountResult = await $`${LVS} ${vg} -o lv_name --noheadings`
      .quiet()
      .nothrow();
    const volumeCount = volumeCountResult.stdout
      .toString()
      .split("\n")
      .filter((line) => line.trim().startsWith("sandbox-")).length;

    if (poolInfo.exitCode !== 0) {
      return {
        exists: false,
        dataPercent: 0,
        metadataPercent: 0,
        totalSize: "0",
        usedSize: "0",
        volumeCount: 0,
      };
    }

    const [size, dataPercent, metadataPercent] = poolInfo.stdout
      .toString()
      .trim()
      .split(/\s+/);
    const dataPct = Number.parseFloat(dataPercent || "0");

    return {
      exists: true,
      dataPercent: dataPct,
      metadataPercent: Number.parseFloat(metadataPercent || "0"),
      totalSize: `${size}G`,
      usedSize: `${((dataPct / 100) * Number.parseFloat(size || "0")).toFixed(1)}G`,
      volumeCount,
    };
  },

  async hasBaseVolume(): Promise<boolean> {
    if (config.isMock()) return true;
    return lvExists(`${vg}/${baseVolume}`);
  },

  async hasImageVolume(imageId: BaseImageId): Promise<boolean> {
    if (config.isMock()) return true;

    const image = getBaseImage(imageId);
    if (!image) return false;

    return lvExists(`${vg}/${image.volumeName}`);
  },

  async hasPrebuild(workspaceId: string): Promise<boolean> {
    if (config.isMock()) return false;
    return lvExists(`${vg}/${prebuildPrefix}${workspaceId}`);
  },

  async createSandboxVolume(
    sandboxId: string,
    options?: { workspaceId?: string; baseImage?: string },
  ): Promise<string> {
    const volumeName = `${sandboxPrefix}${sandboxId}`;
    const volumePath = `/dev/${vg}/${volumeName}`;
    const { workspaceId, baseImage } = options ?? {};

    if (config.isMock()) {
      log.debug(
        { sandboxId, workspaceId, baseImage },
        "Mock: sandbox volume creation",
      );
      return volumePath;
    }

    let sourceVolume: string;
    const baseImageId = baseImage as BaseImageId | undefined;

    if (workspaceId && (await this.hasPrebuild(workspaceId))) {
      sourceVolume = `${prebuildPrefix}${workspaceId}`;
    } else if (baseImageId && (await this.hasImageVolume(baseImageId))) {
      const image = getBaseImage(baseImageId);
      sourceVolume = image?.volumeName ?? baseVolume;
    } else if (await this.hasImageVolume(DEFAULT_BASE_IMAGE)) {
      const defaultImage = getBaseImage(DEFAULT_BASE_IMAGE);
      sourceVolume = defaultImage?.volumeName ?? baseVolume;
    } else {
      sourceVolume = baseVolume;
    }

    log.info({ sandboxId, sourceVolume, baseImage }, "Cloning volume");

    await $`${LVCREATE} -s -kn -n ${volumeName} ${vg}/${sourceVolume}`.quiet();

    log.info({ sandboxId, volumePath, sourceVolume }, "Sandbox volume created");
    return volumePath;
  },

  async deleteSandboxVolume(sandboxId: string): Promise<void> {
    const volumeName = `${sandboxPrefix}${sandboxId}`;

    if (config.isMock()) {
      log.debug({ sandboxId }, "Mock: sandbox volume deletion");
      return;
    }

    await $`${LVREMOVE} -f ${vg}/${volumeName} 2>/dev/null || true`
      .quiet()
      .nothrow();
    log.info({ sandboxId }, "Sandbox volume deleted");
  },

  async createPrebuild(workspaceId: string, sandboxId: string): Promise<void> {
    const prebuildVolume = `${prebuildPrefix}${workspaceId}`;
    const sandboxVolume = `${sandboxPrefix}${sandboxId}`;

    if (config.isMock()) {
      log.debug({ workspaceId, sandboxId }, "Mock: prebuild creation");
      return;
    }

    if (await this.hasPrebuild(workspaceId)) {
      await $`${LVREMOVE} -f ${vg}/${prebuildVolume}`.quiet();
      log.info({ workspaceId }, "Old prebuild removed");
    }

    await $`${LVCREATE} -s -kn -n ${prebuildVolume} ${vg}/${sandboxVolume}`.quiet();
    log.info({ workspaceId, sandboxId }, "Prebuild created from sandbox");
  },

  async deletePrebuild(workspaceId: string): Promise<void> {
    if (config.isMock()) {
      log.debug({ workspaceId }, "Mock: prebuild deletion");
      return;
    }

    await $`${LVREMOVE} -f ${vg}/${prebuildPrefix}${workspaceId} 2>/dev/null || true`
      .quiet()
      .nothrow();
    log.info({ workspaceId }, "Prebuild deleted");
  },

  async listSandboxVolumes(): Promise<VolumeInfo[]> {
    if (config.isMock()) return [];

    const result =
      await $`${LVS} ${vg} -o lv_name,lv_size,data_percent,origin --noheadings`
        .quiet()
        .nothrow();

    if (result.exitCode !== 0) return [];

    return result.stdout
      .toString()
      .trim()
      .split("\n")
      .filter((line) => line.includes("sandbox-"))
      .map((line) => {
        const [name, size, used, origin] = line.trim().split(/\s+/);
        return {
          name: name?.replace("sandbox-", "") || "",
          size: size || "0",
          used: used || "0",
          origin: origin || undefined,
        };
      })
      .filter((v) => v.name);
  },

  async getVolumeInfo(sandboxId: string): Promise<VolumeInfo | null> {
    if (config.isMock()) {
      return { name: sandboxId, size: "4G", used: "1.2" };
    }

    const result =
      await $`${LVS} ${vg}/sandbox-${sandboxId} -o lv_size,data_percent,origin --noheadings`
        .quiet()
        .nothrow();

    if (result.exitCode !== 0) return null;

    const [size, used, origin] = result.stdout.toString().trim().split(/\s+/);
    return {
      name: sandboxId,
      size: size || "0",
      used: used || "0",
      origin: origin || undefined,
    };
  },

  async getVolumeSizeBytes(sandboxId: string): Promise<number> {
    if (config.isMock()) return 5 * 1024 * 1024 * 1024;

    const volumeName = `${sandboxPrefix}${sandboxId}`;
    const result =
      await $`${LVS} ${vg}/${volumeName} -o lv_size --noheadings --units b --nosuffix`
        .quiet()
        .nothrow();

    if (result.exitCode !== 0) return 0;
    return parseInt(result.stdout.toString().trim(), 10);
  },

  async resizeSandboxVolume(
    sandboxId: string,
    newSizeGb: number,
  ): Promise<{
    success: boolean;
    previousSize: number;
    newSize: number;
    error?: string;
  }> {
    const volumeName = `${sandboxPrefix}${sandboxId}`;
    const volumePath = `${vg}/${volumeName}`;

    if (config.isMock()) {
      log.debug({ sandboxId, newSizeGb }, "Mock: sandbox volume resize");
      return {
        success: true,
        previousSize: 5 * 1024 * 1024 * 1024,
        newSize: newSizeGb * 1024 * 1024 * 1024,
      };
    }

    const previousSize = await this.getVolumeSizeBytes(sandboxId);
    const newSizeBytes = newSizeGb * 1024 * 1024 * 1024;

    if (newSizeBytes <= previousSize) {
      return {
        success: false,
        previousSize,
        newSize: previousSize,
        error: `New size (${newSizeGb}GB) must be larger than current size (${Math.round(previousSize / 1024 / 1024 / 1024)}GB)`,
      };
    }

    log.info({ sandboxId, previousSize, newSizeGb }, "Resizing sandbox volume");

    const result = await $`/usr/sbin/lvextend -L ${newSizeGb}G ${volumePath}`
      .quiet()
      .nothrow();

    if (result.exitCode !== 0) {
      const error = result.stderr.toString().trim();
      log.error({ sandboxId, error }, "Failed to resize volume");
      return { success: false, previousSize, newSize: previousSize, error };
    }

    const newSize = await this.getVolumeSizeBytes(sandboxId);
    log.info({ sandboxId, previousSize, newSize }, "Sandbox volume resized");

    return { success: true, previousSize, newSize };
  },
};
