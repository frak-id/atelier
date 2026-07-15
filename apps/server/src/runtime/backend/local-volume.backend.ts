/**
 * Host-directory volume plane for the Docker/local backends — the storage
 * ladder's copy/CoW rung (proposal §6). A sandbox's `/data` is a host directory
 * bind-mounted into the container; a "snapshot" is a copy of that directory,
 * taken with a copy-on-write clone when the host filesystem supports one
 * (`cp -c` → APFS `clonefile`, `cp --reflink=auto` → btrfs/XFS) and a plain
 * recursive copy otherwise. The content-hash key stays identical to the CSI
 * backend, so a prebuild is addressable regardless of which plane took it.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { platform } from "node:os";
import { join } from "node:path";
import { createChildLogger } from "../../shared/lib/logger.ts";
import { appPaths } from "../../shared/lib/paths.ts";
import type { VolumeBackend } from "./backend.types.ts";

const log = createChildLogger("runtime-backend-local-volume");

/** Run a command, resolving to its exit code (never rejects). */
function run(cmd: string, args: string[]): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: "ignore" });
    child.on("error", () => resolve(-1));
    child.on("exit", (code) => resolve(code ?? -1));
  });
}

/**
 * Recursively clone `src` → `dst`, preferring a copy-on-write clone. `dst` must
 * not already exist. Falls back through: platform CoW clone → plain `cp -R` →
 * a hard error (a snapshot that silently didn't copy would corrupt restores).
 */
async function cloneDir(src: string, dst: string): Promise<void> {
  // macOS: `cp -c` forces APFS clonefile (CoW), erroring if unsupported.
  // Linux: `cp --reflink=auto` clones on btrfs/XFS, else copies.
  const cow =
    platform() === "darwin"
      ? ["-c", "-R", src, dst]
      : ["--reflink=auto", "-R", src, dst];
  if ((await run("cp", cow)) === 0) return;

  log.warn({ src, dst }, "CoW clone failed; falling back to plain copy");
  if ((await run("cp", ["-R", src, dst])) === 0) return;

  throw new Error(`failed to clone volume dir ${src} -> ${dst}`);
}

export class LocalVolumeBackend implements VolumeBackend {
  /** `<data>/docker/volumes` — one dir per sandbox (`sandbox-<id>`). */
  private readonly volumesRoot: string;
  /** `<data>/docker/snapshots` — one dir per snapshot ref. */
  private readonly snapshotsRoot: string;

  constructor(baseDir: string = join(appPaths.data, "docker")) {
    this.volumesRoot = join(baseDir, "volumes");
    this.snapshotsRoot = join(baseDir, "snapshots");
  }

  /** Host path of a sandbox's live `/data` volume (`pvcName` = `sandbox-<id>`). */
  volumeDir(pvcName: string): string {
    return join(this.volumesRoot, pvcName);
  }

  private snapshotPath(ref: string): string {
    return join(this.snapshotsRoot, ref);
  }

  /**
   * Ensure a sandbox's live volume dir exists. On a fresh boot it's created
   * empty; booting from a snapshot clones that snapshot's contents (the CoW
   * equivalent of a CSI PVC `dataSource`). Reuse (resume) leaves an existing
   * dir untouched.
   */
  async ensureVolume(pvcName: string, fromSnapshot?: string): Promise<void> {
    const dir = this.volumeDir(pvcName);
    if (existsSync(dir)) return;
    await mkdir(this.volumesRoot, { recursive: true });
    if (fromSnapshot) {
      const src = this.snapshotPath(fromSnapshot);
      if (!existsSync(src)) {
        throw new Error(`snapshot ${fromSnapshot} not found at ${src}`);
      }
      await cloneDir(src, dir);
    } else {
      await mkdir(dir, { recursive: true });
    }
  }

  /** Remove a sandbox's live volume dir (full teardown). */
  async deleteVolume(pvcName: string): Promise<void> {
    await rm(this.volumeDir(pvcName), { recursive: true, force: true });
  }

  async snapshot(pvcName: string, ref: string): Promise<void> {
    const dir = this.volumeDir(pvcName);
    if (!existsSync(dir)) {
      throw new Error(`cannot snapshot missing volume dir ${dir}`);
    }
    await mkdir(this.snapshotsRoot, { recursive: true });
    // Idempotent on ref: a forced rebuild may resolve to an existing name.
    await rm(this.snapshotPath(ref), { recursive: true, force: true });
    await cloneDir(dir, this.snapshotPath(ref));
  }

  async deleteSnapshot(ref: string): Promise<void> {
    await rm(this.snapshotPath(ref), { recursive: true, force: true });
  }

  volumeExists(pvcName: string): Promise<boolean> {
    return Promise.resolve(existsSync(this.volumeDir(pvcName)));
  }
}
