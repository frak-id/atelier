import { LVM } from "@frak-sandbox/shared/constants";
import type { BaseImageId } from "@frak-sandbox/shared/types";
import { DEFAULT_BASE_IMAGE, getBaseImage } from "@frak-sandbox/shared/types";
import { $ } from "bun";
import { config } from "../lib/config.ts";
import { createChildLogger } from "../lib/logger.ts";
import { commandExists } from "../lib/shell.ts";

const log = createChildLogger("storage");

export interface VolumeInfo {
  name: string;
  size: string;
  used: string;
  origin?: string;
}

export interface PoolStats {
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
const VGS = "/usr/sbin/vgs";
const prebuildPrefix = LVM.PREBUILD_PREFIX;

async function lvExists(volumePath: string): Promise<boolean> {
  const result = await $`${LVS} ${volumePath} --noheadings 2>/dev/null`
    .quiet()
    .nothrow();
  return result.exitCode === 0;
}

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

  async hasPrebuild(projectId: string): Promise<boolean> {
    if (config.isMock()) return false;
    return lvExists(`${vg}/${prebuildPrefix}${projectId}`);
  },

  async createSandboxVolume(
    sandboxId: string,
    options?: { projectId?: string; baseImage?: BaseImageId },
  ): Promise<string> {
    const volumeName = `${sandboxPrefix}${sandboxId}`;
    const volumePath = `/dev/${vg}/${volumeName}`;
    const { projectId, baseImage } = options ?? {};

    if (config.isMock()) {
      log.debug(
        { sandboxId, projectId, baseImage },
        "Mock: sandbox volume creation",
      );
      return volumePath;
    }

    let sourceVolume: string;

    if (projectId && (await this.hasPrebuild(projectId))) {
      sourceVolume = `${prebuildPrefix}${projectId}`;
    } else if (baseImage && (await this.hasImageVolume(baseImage))) {
      const image = getBaseImage(baseImage);
      sourceVolume = image?.volumeName;
    } else if (await this.hasImageVolume(DEFAULT_BASE_IMAGE)) {
      const defaultImage = getBaseImage(DEFAULT_BASE_IMAGE);
      sourceVolume = defaultImage?.volumeName;
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

  async createPrebuild(projectId: string, sandboxId: string): Promise<void> {
    const prebuildVolume = `${prebuildPrefix}${projectId}`;
    const sandboxVolume = `${sandboxPrefix}${sandboxId}`;

    if (config.isMock()) {
      log.debug({ projectId, sandboxId }, "Mock: prebuild creation");
      return;
    }

    if (await this.hasPrebuild(projectId)) {
      await $`${LVREMOVE} -f ${vg}/${prebuildVolume}`.quiet();
      log.info({ projectId }, "Old prebuild removed");
    }

    await $`${LVCREATE} -s -n ${prebuildVolume} ${vg}/${sandboxVolume}`.quiet();
    log.info({ projectId, sandboxId }, "Prebuild created from sandbox");
  },

  async deletePrebuild(projectId: string): Promise<void> {
    if (config.isMock()) {
      log.debug({ projectId }, "Mock: prebuild deletion");
      return;
    }

    await $`${LVREMOVE} -f ${vg}/${prebuildPrefix}${projectId} 2>/dev/null || true`
      .quiet()
      .nothrow();
    log.info({ projectId }, "Prebuild deleted");
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
};
