/**
 * Regression coverage for the zip-context security guards (H10 — no prior
 * coverage existed for traversal/symlink/oversize on the upload path):
 *   - S1: an archive whose DECLARED uncompressed size exceeds the cap is
 *     rejected before any extraction happens.
 *   - S2: a symlinked entry (e.g. a `Dockerfile -> /etc/hosts`) is rejected
 *     rather than followed.
 *   - path traversal entries (`../…`) are rejected even though `unzip`
 *     itself already refuses them by default.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.ATELIER_SERVER_MODE = "mock";

const { readContextDockerfile, unpackZipContext } = await import(
  "./zip-context.ts"
);

let workDir: string;

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), "atelier-zip-context-test-"));
});

afterEach(async () => {
  await rm(workDir, { recursive: true, force: true });
});

/** Build a zip at `zipPath` by staging `files` under a scratch dir and
 * shelling out to the same `zip` CLI a real upload would've used. */
async function buildZip(
  files: Array<
    { name: string; content: string } | { symlink: string; target: string }
  >,
): Promise<string> {
  const stageDir = join(
    workDir,
    `stage-${Math.random().toString(36).slice(2)}`,
  );
  await mkdir(stageDir, { recursive: true });
  const entryNames: string[] = [];
  for (const file of files) {
    if ("symlink" in file) {
      await mkdir(join(stageDir, file.symlink, ".."), { recursive: true });
      await symlink(file.target, join(stageDir, file.symlink));
      entryNames.push(file.symlink);
    } else {
      const dest = join(stageDir, file.name);
      await mkdir(join(dest, ".."), { recursive: true });
      await writeFile(dest, file.content);
      entryNames.push(file.name);
    }
  }
  const zipPath = join(workDir, `${Math.random().toString(36).slice(2)}.zip`);
  const proc = Bun.spawnSync(["zip", "-q", "-y", zipPath, ...entryNames], {
    cwd: stageDir,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (proc.exitCode !== 0) {
    throw new Error(`test fixture zip failed: ${proc.stderr.toString()}`);
  }
  return zipPath;
}

/** Build a zip containing a single entry whose name escapes the stage dir
 * via `../`, by zipping from a nested cwd (mirrors how a crafted archive
 * would record a `../` path in its central directory). */
async function buildTraversalZip(): Promise<string> {
  const base = join(workDir, "traversal-base");
  const nested = join(base, "nested");
  await mkdir(nested, { recursive: true });
  await writeFile(join(base, "evil.txt"), "escaped content");
  const zipPath = join(workDir, "traversal.zip");
  const proc = Bun.spawnSync(["zip", "-q", zipPath, "../evil.txt"], {
    cwd: nested,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (proc.exitCode !== 0) {
    throw new Error(`test fixture zip failed: ${proc.stderr.toString()}`);
  }
  return zipPath;
}

/** Build a zip declaring a single file whose UNCOMPRESSED size is well over
 * the 100MB cap but that's tiny on disk (highly compressible zeros) — this
 * is the shape of guard S1 has to catch from the declared size alone,
 * before extracting. */
async function buildOversizedZip(): Promise<string> {
  const stageDir = join(workDir, "oversized-stage");
  await mkdir(stageDir, { recursive: true });
  const bigFile = join(stageDir, "big.bin");
  // 105MB of zeros — over the 100MB cap, compresses to a few KB.
  const dd = Bun.spawnSync(
    ["dd", "if=/dev/zero", `of=${bigFile}`, "bs=1m", "count=105"],
    { stdout: "pipe", stderr: "pipe" },
  );
  if (dd.exitCode !== 0) {
    throw new Error(`test fixture dd failed: ${dd.stderr.toString()}`);
  }
  const zipPath = join(workDir, "oversized.zip");
  const zip = Bun.spawnSync(["zip", "-q", zipPath, "big.bin"], {
    cwd: stageDir,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (zip.exitCode !== 0) {
    throw new Error(`test fixture zip failed: ${zip.stderr.toString()}`);
  }
  return zipPath;
}

describe("unpackZipContext", () => {
  test("rejects path-traversal entries", async () => {
    const zipPath = await buildTraversalZip();
    await expect(unpackZipContext(zipPath)).rejects.toThrow(
      /escapes the build context/,
    );
  });

  test("rejects a symlinked Dockerfile after extraction", async () => {
    const zipPath = await buildZip([
      { symlink: "Dockerfile", target: "/etc/hosts" },
    ]);
    await expect(unpackZipContext(zipPath)).rejects.toThrow(/symlink/);
  });

  test("rejects a symlink entry anywhere in the tree, not just at the root", async () => {
    const zipPath = await buildZip([
      { name: "Dockerfile", content: "FROM alpine\n" },
      { symlink: "nested/link", target: "/etc/passwd" },
    ]);
    await expect(unpackZipContext(zipPath)).rejects.toThrow(/symlink/);
  });

  test("rejects an archive whose declared uncompressed size exceeds the cap, before extraction", async () => {
    const zipPath = await buildOversizedZip();
    await expect(unpackZipContext(zipPath)).rejects.toThrow(
      /exceeds the .* byte limit — rejected before extraction/,
    );
  });

  test("accepts a well-formed Dockerfile + rootfs context", async () => {
    const zipPath = await buildZip([
      { name: "Dockerfile", content: "FROM alpine\nRUN echo hi\n" },
      { name: "rootfs/etc/motd", content: "hello\n" },
    ]);
    const contextDir = await unpackZipContext(zipPath);
    try {
      const dockerfile = await readContextDockerfile(contextDir);
      expect(dockerfile).toContain("FROM alpine");
    } finally {
      await rm(contextDir, { recursive: true, force: true });
    }
  });
});

describe("readContextDockerfile", () => {
  test("rejects a symlinked Dockerfile without following it", async () => {
    const contextDir = join(workDir, "manual-context");
    await mkdir(contextDir, { recursive: true });
    await symlink("/etc/hosts", join(contextDir, "Dockerfile"));
    await expect(readContextDockerfile(contextDir)).rejects.toThrow(/symlink/);
  });

  test("rejects a missing Dockerfile", async () => {
    const contextDir = join(workDir, "empty-context");
    await mkdir(contextDir, { recursive: true });
    await expect(readContextDockerfile(contextDir)).rejects.toThrow(
      /does not contain a Dockerfile/,
    );
  });
});
