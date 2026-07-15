/**
 * Docker named-volume storage plane for the Docker backend.
 *
 * WHY NAMED VOLUMES, NOT HOST-DIR BIND MOUNTS: the guest agent assembles
 * `/home/dev` as an overlayfs whose upperdir lives on `/data`. overlayfs
 * requires a real Linux filesystem (proper d_type + xattrs) for that upperdir —
 * a macOS host directory bind-mounted through virtiofs does NOT qualify, so the
 * overlay silently mounts read-only and every write fails. A Docker named
 * volume lives on the VM's ext4 and works. It also sidesteps the host-side
 * permission problem: the container runs as root, so its files can't be
 * `rm`-ed by the host user — `docker volume rm` handles teardown cleanly.
 *
 * A snapshot is another named volume, filled by a throwaway `cp -a` container
 * (no host-side CoW clone available across named volumes). Same content-hash
 * key as the CSI backend, so a prebuild stays addressable across planes.
 */
import type { VolumeBackend } from "./backend.types.ts";
import { docker } from "./docker-cli.ts";

export interface DockerVolumeBackendOptions {
  /** Tiny image used to copy volume contents (needs `cp`). Pulled on demand. */
  helperImage?: string;
  dockerBin?: string;
}

export class DockerVolumeBackend implements VolumeBackend {
  private readonly helperImage: string;
  private readonly bin: string;

  constructor(options: DockerVolumeBackendOptions = {}) {
    this.helperImage = options.helperImage ?? "alpine";
    this.bin = options.dockerBin ?? "docker";
  }

  /** Volume name for a sandbox's live `/data` (`pvcName` = `sandbox-<id>`). */
  volumeName(pvcName: string): string {
    return pvcName;
  }

  private async exists(volume: string): Promise<boolean> {
    const res = await docker(["volume", "inspect", volume], this.bin);
    return res.code === 0;
  }

  private async create(volume: string): Promise<void> {
    const res = await docker(["volume", "create", volume], this.bin);
    if (res.code !== 0) {
      throw new Error(`docker volume create ${volume} failed: ${res.stderr}`);
    }
  }

  /** Copy every entry of `from` into `to` via a throwaway helper container
   * (both are root-owned Linux volumes, so the copy must run in-container). */
  private async copyVolume(from: string, to: string): Promise<void> {
    const res = await docker(
      [
        "run",
        "--rm",
        "-v",
        `${from}:/from:ro`,
        "-v",
        `${to}:/to`,
        this.helperImage,
        "sh",
        "-c",
        "cp -a /from/. /to/",
      ],
      this.bin,
    );
    if (res.code !== 0) {
      throw new Error(`volume copy ${from} -> ${to} failed: ${res.stderr}`);
    }
  }

  /**
   * Ensure a sandbox's live volume exists. Fresh boot creates it empty; a
   * snapshot boot clones the snapshot volume into it (the CoW-PVC-dataSource
   * analogue); resume reuses an existing volume untouched.
   */
  async ensureVolume(pvcName: string, fromSnapshot?: string): Promise<void> {
    const volume = this.volumeName(pvcName);
    if (await this.exists(volume)) return;
    await this.create(volume);
    if (fromSnapshot) {
      if (!(await this.exists(fromSnapshot))) {
        throw new Error(`snapshot volume ${fromSnapshot} not found`);
      }
      await this.copyVolume(fromSnapshot, volume);
    }
  }

  async deleteVolume(pvcName: string): Promise<void> {
    await docker(["volume", "rm", "-f", this.volumeName(pvcName)], this.bin);
  }

  async snapshot(pvcName: string, ref: string): Promise<void> {
    const volume = this.volumeName(pvcName);
    if (!(await this.exists(volume))) {
      throw new Error(`cannot snapshot missing volume ${volume}`);
    }
    // Idempotent on ref: a forced rebuild may resolve to an existing name.
    await docker(["volume", "rm", "-f", ref], this.bin);
    await this.create(ref);
    await this.copyVolume(volume, ref);
  }

  async deleteSnapshot(ref: string): Promise<void> {
    await docker(["volume", "rm", "-f", ref], this.bin);
  }

  async volumeExists(pvcName: string): Promise<boolean> {
    return this.exists(this.volumeName(pvcName));
  }
}
