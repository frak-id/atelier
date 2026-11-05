/**
 * The Docker backend's volume bookkeeping against a scripted fake `docker`
 * binary (no daemon): snapshots carry their owner label, cleanup removes the
 * sandbox's labelled snapshot volumes, and a failing `docker rm` / `docker
 * volume rm` makes cleanup report failure instead of success.
 */
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DockerBackend } from "./docker.backend.ts";
import { DockerVolumeBackend } from "./docker-volume.backend.ts";

let dir: string;
let bin: string;
let log: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "fake-docker-"));
  bin = join(dir, "docker");
  log = join(dir, "calls.log");
  await writeFile(
    bin,
    `#!/bin/sh
echo "$@" >> "$FAKE_DOCKER_LOG"
case "$1 $2" in
  "volume ls") printf 'snap-a\\nsnap-b\\n';;
  "rm -f")
    if [ -n "$FAKE_DOCKER_RM_FAIL" ]; then echo "$FAKE_DOCKER_RM_FAIL" >&2; exit 1; fi;;
  "volume rm")
    if [ -n "$FAKE_DOCKER_VOLUME_RM_FAIL" ]; then echo "in use" >&2; exit 1; fi;;
esac
exit 0
`,
  );
  await chmod(bin, 0o755);
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

beforeEach(async () => {
  await writeFile(log, "");
  process.env.FAKE_DOCKER_LOG = log;
  delete process.env.FAKE_DOCKER_RM_FAIL;
  delete process.env.FAKE_DOCKER_VOLUME_RM_FAIL;
});

const calls = async () =>
  (await readFile(log, "utf8")).split("\n").filter(Boolean);

function makeBackend() {
  const volumes = new DockerVolumeBackend({ dockerBin: bin });
  return new DockerBackend({ volumes, dockerBin: bin });
}

describe("DockerVolumeBackend.snapshot", () => {
  test("creates the snapshot volume with the owner label", async () => {
    const volumes = new DockerVolumeBackend({ dockerBin: bin });
    await volumes.snapshot("sandbox-sb1", "snap-x", {
      "atelier.dev/sandbox": "sb1",
    });
    expect(await calls()).toContain(
      "volume create --label atelier.dev/sandbox=sb1 snap-x",
    );
  });
});

describe("DockerBackend.cleanup", () => {
  test("removes the container, the live volume and the labelled snapshots", async () => {
    const ok = await makeBackend().cleanup("sb1");
    expect(ok).toBe(true);
    const seen = await calls();
    expect(seen).toContain("rm -f sandbox-sb1");
    expect(seen).toContain("volume rm -f sandbox-sb1");
    expect(seen).toContain(
      "volume ls -q --filter label=atelier.dev/sandbox=sb1",
    );
    expect(seen).toContain("volume rm -f snap-a");
    expect(seen).toContain("volume rm -f snap-b");
  });

  test("a container that is already gone is fine", async () => {
    process.env.FAKE_DOCKER_RM_FAIL = "Error: No such container: sandbox-sb1";
    expect(await makeBackend().cleanup("sb1")).toBe(true);
  });

  test("a failing `docker rm` is reported, and the sweep still goes on", async () => {
    process.env.FAKE_DOCKER_RM_FAIL = "permission denied";
    expect(await makeBackend().cleanup("sb1")).toBe(false);
    expect(await calls()).toContain("volume rm -f snap-a");
  });

  test("a failing `docker volume rm` is reported", async () => {
    process.env.FAKE_DOCKER_VOLUME_RM_FAIL = "1";
    expect(await makeBackend().cleanup("sb1")).toBe(false);
  });
});

describe("DockerBackend.exposePort", () => {
  test("refuses a port the container did not publish at boot", async () => {
    // The fake `docker port` prints nothing: the port is not mapped.
    await expect(
      makeBackend().exposePort("sb1", {
        name: "web",
        port: 5173,
        public: true,
      }),
    ).rejects.toThrow(/Cannot expose port 5173/);
  });
});
