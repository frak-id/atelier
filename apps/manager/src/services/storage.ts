import { LVM } from "@frak-sandbox/shared/constants";
import type { BaseImageId } from "@frak-sandbox/shared/types";
import { DEFAULT_BASE_IMAGE, getBaseImage } from "@frak-sandbox/shared/types";
import { exec, commandExists } from "../lib/shell.ts";
import { config } from "../lib/config.ts";
import { createChildLogger } from "../lib/logger.ts";

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

export const StorageService = {
  async isAvailable(): Promise<boolean> {
    if (config.isMock()) {
      return true;
    }

    const hasLvm = await commandExists("lvm");
    if (!hasLvm) return false;

    const poolCheck = await exec(
      `lvs ${LVM.VG_NAME}/${LVM.THIN_POOL} --noheadings 2>/dev/null`,
      { throws: false }
    );

    return poolCheck.success;
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

    const poolInfo = await exec(
      `lvs ${LVM.VG_NAME}/${LVM.THIN_POOL} -o lv_size,data_percent,metadata_percent --noheadings --units g --nosuffix`,
      { throws: false }
    );

    const volumeCount = await exec(
      `lvs ${LVM.VG_NAME} -o lv_name --noheadings | grep -c '^  sandbox-' || echo 0`,
      { throws: false }
    );

    if (!poolInfo.success) {
      return {
        exists: false,
        dataPercent: 0,
        metadataPercent: 0,
        totalSize: "0",
        usedSize: "0",
        volumeCount: 0,
      };
    }

    const [size, dataPercent, metadataPercent] = poolInfo.stdout.trim().split(/\s+/);
    const dataPct = Number.parseFloat(dataPercent || "0");

    return {
      exists: true,
      dataPercent: dataPct,
      metadataPercent: Number.parseFloat(metadataPercent || "0"),
      totalSize: `${size}G`,
      usedSize: `${((dataPct / 100) * Number.parseFloat(size || "0")).toFixed(1)}G`,
      volumeCount: Number.parseInt(volumeCount.stdout.trim() || "0", 10),
    };
  },

  async hasBaseVolume(): Promise<boolean> {
    if (config.isMock()) return true;

    const result = await exec(
      `lvs ${LVM.VG_NAME}/${LVM.BASE_VOLUME} --noheadings 2>/dev/null`,
      { throws: false }
    );
    return result.success;
  },

  async hasImageVolume(imageId: BaseImageId): Promise<boolean> {
    if (config.isMock()) return true;

    const image = getBaseImage(imageId);
    if (!image) return false;

    const result = await exec(
      `lvs ${LVM.VG_NAME}/${image.volumeName} --noheadings 2>/dev/null`,
      { throws: false }
    );
    return result.success;
  },

  async hasPrebuild(projectId: string): Promise<boolean> {
    if (config.isMock()) return false;

    const result = await exec(
      `lvs ${LVM.VG_NAME}/${LVM.PREBUILD_PREFIX}${projectId} --noheadings 2>/dev/null`,
      { throws: false }
    );
    return result.success;
  },

  async createSandboxVolume(
    sandboxId: string,
    options?: { projectId?: string; baseImage?: BaseImageId }
  ): Promise<string> {
    const volumeName = `${LVM.SANDBOX_PREFIX}${sandboxId}`;
    const volumePath = `/dev/${LVM.VG_NAME}/${volumeName}`;
    const { projectId, baseImage } = options ?? {};

    if (config.isMock()) {
      log.debug({ sandboxId, projectId, baseImage }, "Mock: sandbox volume creation");
      return volumePath;
    }

    // Priority: prebuild > image volume > legacy base volume
    let sourceVolume: string;

    if (projectId && (await this.hasPrebuild(projectId))) {
      sourceVolume = `${LVM.PREBUILD_PREFIX}${projectId}`;
    } else if (baseImage && (await this.hasImageVolume(baseImage))) {
      const image = getBaseImage(baseImage);
      sourceVolume = image!.volumeName;
    } else if (await this.hasImageVolume(DEFAULT_BASE_IMAGE)) {
      const defaultImage = getBaseImage(DEFAULT_BASE_IMAGE);
      sourceVolume = defaultImage!.volumeName;
    } else {
      sourceVolume = LVM.BASE_VOLUME;
    }

    log.info({ sandboxId, sourceVolume, baseImage }, "Cloning volume");

    await exec(
      `lvcreate -s -kn -n ${volumeName} ${LVM.VG_NAME}/${sourceVolume}`,
      { throws: true }
    );

    log.info({ sandboxId, volumePath, sourceVolume }, "Sandbox volume created");
    return volumePath;
  },

  async deleteSandboxVolume(sandboxId: string): Promise<void> {
    const volumeName = `${LVM.SANDBOX_PREFIX}${sandboxId}`;

    if (config.isMock()) {
      log.debug({ sandboxId }, "Mock: sandbox volume deletion");
      return;
    }

    await exec(`lvremove -f ${LVM.VG_NAME}/${volumeName} 2>/dev/null || true`);
    log.info({ sandboxId }, "Sandbox volume deleted");
  },

  async createPrebuild(projectId: string, sandboxId: string): Promise<void> {
    const prebuildVolume = `${LVM.PREBUILD_PREFIX}${projectId}`;
    const sandboxVolume = `${LVM.SANDBOX_PREFIX}${sandboxId}`;

    if (config.isMock()) {
      log.debug({ projectId, sandboxId }, "Mock: prebuild creation");
      return;
    }

    if (await this.hasPrebuild(projectId)) {
      await exec(`lvremove -f ${LVM.VG_NAME}/${prebuildVolume}`);
      log.info({ projectId }, "Old prebuild removed");
    }

    await exec(`lvcreate -s -n ${prebuildVolume} ${LVM.VG_NAME}/${sandboxVolume}`);
    log.info({ projectId, sandboxId }, "Prebuild created from sandbox");
  },

  async deletePrebuild(projectId: string): Promise<void> {
    if (config.isMock()) {
      log.debug({ projectId }, "Mock: prebuild deletion");
      return;
    }

    await exec(`lvremove -f ${LVM.VG_NAME}/${LVM.PREBUILD_PREFIX}${projectId} 2>/dev/null || true`);
    log.info({ projectId }, "Prebuild deleted");
  },

  async listSandboxVolumes(): Promise<VolumeInfo[]> {
    if (config.isMock()) {
      return [];
    }

    const result = await exec(
      `lvs ${LVM.VG_NAME} -o lv_name,lv_size,data_percent,origin --noheadings | grep '  sandbox-'`,
      { throws: false }
    );

    if (!result.success || !result.stdout.trim()) {
      return [];
    }

    return result.stdout
      .trim()
      .split("\n")
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

    const result = await exec(
      `lvs ${LVM.VG_NAME}/sandbox-${sandboxId} -o lv_size,data_percent,origin --noheadings`,
      { throws: false }
    );

    if (!result.success) {
      return null;
    }

    const [size, used, origin] = result.stdout.trim().split(/\s+/);
    return {
      name: sandboxId,
      size: size || "0",
      used: used || "0",
      origin: origin || undefined,
    };
  },
};
