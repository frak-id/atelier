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
 *
 * XATTR PRESERVATION: the overlay upperdir on `/data` now stores its metadata
 * in `trusted.overlay.*` xattrs (redirect/opaque markers — the agent dropped
 * `userxattr` for real trusted xattrs). Copying a volume must preserve them or
 * a snapshot/resume silently loses redirect/whiteout state (deleted files
 * reappear; renamed dirs break). That needs (a) GNU coreutils `cp` — BusyBox
 * (alpine) `cp -a` drops xattrs — and (b) `CAP_SYS_ADMIN`, since reading and
 * writing `trusted.*` is privileged. Hence the coreutils helper image +
 * `--cap-add=SYS_ADMIN` below.
 */
import type { VolumeBackend } from "./backend.types.ts";
import { docker } from "./docker-cli.ts";

/** The label that ties a snapshot volume to the sandbox that owns it. */
const OWNER_LABEL = "atelier.dev/sandbox";

export interface DockerVolumeBackendOptions {
  /** Tiny image used to copy volume contents (needs `cp`). Pulled on demand. */
  helperImage?: string;
  dockerBin?: string;
}

export class DockerVolumeBackend implements VolumeBackend {
  private readonly helperImage: string;
  private readonly bin: string;

  constructor(options: DockerVolumeBackendOptions = {}) {
    // Debian slim ships GNU coreutils (`cp -a` == `--preserve=all`, which
    // includes xattrs) and GNU tar; BusyBox `alpine` silently drops the
    // `trusted.overlay.*` markers the overlay upper depends on.
    this.helperImage = options.helperImage ?? "debian:stable-slim";
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

  private async create(
    volume: string,
    labels: Record<string, string> = {},
  ): Promise<void> {
    const labelArgs = Object.entries(labels).flatMap(([k, v]) => [
      "--label",
      `${k}=${v}`,
    ]);
    const res = await docker(
      ["volume", "create", ...labelArgs, volume],
      this.bin,
    );
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
        // trusted.* xattr read (source) + write (dest) is privileged.
        "--cap-add=SYS_ADMIN",
        "-v",
        `${from}:/from:ro`,
        "-v",
        `${to}:/to`,
        this.helperImage,
        "sh",
        "-c",
        // GNU `cp -a` preserves xattrs (incl. trusted.overlay.*) and device
        // nodes (overlay whiteouts). `.` copies dotfiles + the dir's xattrs.
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
    await this.removeVolume(this.volumeName(pvcName));
  }

  /** `docker volume rm -f` (an already-gone volume is fine); a failure
   * (e.g. a container still uses it) throws instead of passing silently. */
  private async removeVolume(volume: string): Promise<void> {
    const res = await docker(["volume", "rm", "-f", volume], this.bin);
    if (res.code !== 0) {
      throw new Error(`docker volume rm ${volume} failed: ${res.stderr}`);
    }
  }

  /** Remove every snapshot volume labelled as owned by `sandboxId` (the
   * Docker analogue of the k8s label sweep over VolumeSnapshots). */
  async deleteSnapshotsOwnedBy(sandboxId: string): Promise<void> {
    const res = await docker(
      ["volume", "ls", "-q", "--filter", `label=${OWNER_LABEL}=${sandboxId}`],
      this.bin,
    );
    if (res.code !== 0) {
      throw new Error(`docker volume ls failed: ${res.stderr}`);
    }
    for (const volume of res.stdout.split("\n").filter(Boolean)) {
      await this.removeVolume(volume);
    }
  }

  async snapshot(
    pvcName: string,
    ref: string,
    labels: Record<string, string>,
  ): Promise<void> {
    const volume = this.volumeName(pvcName);
    if (!(await this.exists(volume))) {
      throw new Error(`cannot snapshot missing volume ${volume}`);
    }
    // Idempotent on ref: a forced rebuild may resolve to an existing name.
    await this.removeVolume(ref);
    await this.create(ref, labels);
    await this.copyVolume(volume, ref);
  }

  async deleteSnapshot(ref: string): Promise<void> {
    await this.removeVolume(ref);
  }

  /** A volume's labels are immutable, so a new owner means a copy: stage the
   * content aside, recreate the volume under the new label, copy back. */
  async reownSnapshot(ref: string, ownerId: string): Promise<void> {
    const staging = `${ref}-reown`;
    await this.removeVolume(staging);
    await this.create(staging);
    await this.copyVolume(ref, staging);
    await this.removeVolume(ref);
    await this.create(ref, { [OWNER_LABEL]: ownerId });
    await this.copyVolume(staging, ref);
    // Kept (not removed) when a step above fails: it may hold the only copy.
    await this.removeVolume(staging);
  }

  async volumeExists(pvcName: string): Promise<boolean> {
    return this.exists(this.volumeName(pvcName));
  }
}
