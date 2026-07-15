/**
 * LocalVolumeBackend: host-directory volumes with copy/CoW-clone snapshots
 * (proposal §6 storage ladder). Real filesystem ops in a temp base dir.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalVolumeBackend } from "./local-volume.backend.ts";

let base: string;
let vol: LocalVolumeBackend;

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), "atelier-vol-"));
  vol = new LocalVolumeBackend(base);
});

afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

describe("LocalVolumeBackend", () => {
  test("ensureVolume creates an empty dir; volumeExists reflects it", async () => {
    expect(await vol.volumeExists("sandbox-a")).toBe(false);
    await vol.ensureVolume("sandbox-a");
    expect(await vol.volumeExists("sandbox-a")).toBe(true);
    expect(existsSync(vol.volumeDir("sandbox-a"))).toBe(true);
  });

  test("ensureVolume is idempotent (resume reuses the dir)", async () => {
    await vol.ensureVolume("sandbox-a");
    await writeFile(join(vol.volumeDir("sandbox-a"), "keep.txt"), "live");
    await vol.ensureVolume("sandbox-a"); // must not clobber
    expect(
      await readFile(join(vol.volumeDir("sandbox-a"), "keep.txt"), "utf8"),
    ).toBe("live");
  });

  test("snapshot clones content; clone-from-snapshot restores it", async () => {
    await vol.ensureVolume("sandbox-a");
    await writeFile(join(vol.volumeDir("sandbox-a"), "data.txt"), "v1");

    await vol.snapshot("sandbox-a", "snap-1");

    // Mutating the live volume after the snapshot must not affect the snapshot.
    await writeFile(join(vol.volumeDir("sandbox-a"), "data.txt"), "v2");

    // Boot a new sandbox from the snapshot — its dir is the snapshot's content.
    await vol.ensureVolume("sandbox-b", "snap-1");
    expect(
      await readFile(join(vol.volumeDir("sandbox-b"), "data.txt"), "utf8"),
    ).toBe("v1");
  });

  test("snapshot is idempotent on ref (forced rebuild replaces it)", async () => {
    await vol.ensureVolume("sandbox-a");
    await writeFile(join(vol.volumeDir("sandbox-a"), "f"), "one");
    await vol.snapshot("sandbox-a", "snap-x");
    await writeFile(join(vol.volumeDir("sandbox-a"), "f"), "two");
    await vol.snapshot("sandbox-a", "snap-x"); // replace, not collide

    await vol.ensureVolume("sandbox-c", "snap-x");
    expect(await readFile(join(vol.volumeDir("sandbox-c"), "f"), "utf8")).toBe(
      "two",
    );
  });

  test("deleteVolume and deleteSnapshot remove dirs", async () => {
    await vol.ensureVolume("sandbox-a");
    await vol.snapshot("sandbox-a", "snap-1");
    await vol.deleteVolume("sandbox-a");
    await vol.deleteSnapshot("snap-1");
    expect(await vol.volumeExists("sandbox-a")).toBe(false);
    // Cloning from a deleted snapshot fails loudly.
    await expect(vol.ensureVolume("sandbox-d", "snap-1")).rejects.toThrow(
      /not found/,
    );
  });

  test("snapshot of a missing volume fails loudly", async () => {
    await expect(vol.snapshot("sandbox-missing", "snap")).rejects.toThrow(
      /missing volume/,
    );
  });
});
