/**
 * Unpack a user-uploaded zip into a fresh temp build-context directory for
 * `ImageBuilderService.buildDockerfile`. Shells out to `unzip`/`zipinfo`
 * (same "a CLI binary on PATH" convention as `docker-cli.ts`) rather than
 * pulling in a zip-parsing dependency.
 *
 * Guards this module exists to enforce (design review: "arbitrary
 * Dockerfiles bite"):
 *   - the archive's DECLARED uncompressed size is summed and checked BEFORE
 *     extraction, so a nested-deflate zip bomb can't fill the host disk
 *     mid-extract; the post-extraction `du` measurement stays as a backstop
 *     in case the declared sizes ever lie;
 *   - `unzip` itself refuses `../` path-traversal entries by default, but we
 *     double-check the listing before extracting so a crafted entry can't
 *     write outside the temp dir even if some `unzip` build's default ever
 *     changed;
 *   - after extraction, every entry is walked and rejected if it's a
 *     symlink — `unzip` restores symlink entries verbatim, and a
 *     Dockerfile+rootfs upload never legitimately needs one. Without this a
 *     `Dockerfile -> /etc/shadow` symlink entry would have its target read
 *     and persisted by `readContextDockerfile`.
 */
import { spawn } from "node:child_process";
import { lstat, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, normalize } from "node:path";
import { ValidationError } from "../../shared/errors.ts";

/** Hard cap on a build context's total unpacked size. */
const MAX_CONTEXT_BYTES = 100 * 1024 * 1024;

function run(
  bin: string,
  args: string[],
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(bin, args);
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => {
      stdout += d;
    });
    child.stderr.on("data", (d) => {
      stderr += d;
    });
    child.on("error", (e) => resolve({ code: -1, stdout, stderr: `${e}` }));
    child.on("exit", (code) => resolve({ code: code ?? -1, stdout, stderr }));
  });
}

/** Reject any entry that isn't a clean relative path under the extraction
 * root — defense in depth on top of `unzip`'s own traversal protection. */
function assertSafeEntries(names: string[]): void {
  for (const name of names) {
    const normalized = normalize(name);
    if (normalized.startsWith("..") || normalized.startsWith("/")) {
      throw new ValidationError(
        `Zip entry '${name}' escapes the build context — rejected.`,
      );
    }
  }
}

/**
 * Fixed-width `zipinfo` entry line, e.g.
 * `-rw-r--r--  3.0 unx       20 tx stor 20260716.140618 Dockerfile`
 * (perms, made-by version, host-os, SIZE, text/binary, method, timestamp,
 * name). The name may contain spaces, so it's captured as the remainder
 * after the 7 fixed fields rather than split on whitespace.
 */
const ZIPINFO_ENTRY_RE = /^\S+\s+\S+\s+\S+\s+(\d+)\s+\S+\s+\S+\s+\S+\s+(.+)$/;

/** Sum the DECLARED (pre-extraction) uncompressed size of every entry —
 * read from the zip's central directory, never by extracting. A zip bomb
 * lies about compression ratio, not this field, so this is the guard that
 * has to run first. */
async function sumDeclaredSize(zipPath: string): Promise<number> {
  const info = await run("zipinfo", ["-T", zipPath]);
  if (info.code !== 0) {
    throw new ValidationError(`Could not read zip archive: ${info.stderr}`);
  }
  let total = 0;
  for (const line of info.stdout.split("\n")) {
    const match = ZIPINFO_ENTRY_RE.exec(line);
    if (!match) continue;
    total += Number.parseInt(match[1] ?? "0", 10);
  }
  return total;
}

/** Unpack `zipPath` into a new temp dir and return it. Caller owns cleanup
 * (`rm(contextDir, { recursive: true, force: true })`) — mirrors how
 * `ImageBuilderService.buildDockerfile`'s single-file context is cleaned up
 * by its caller when it created the context itself. */
export async function unpackZipContext(zipPath: string): Promise<string> {
  const listing = await run("unzip", ["-Z1", zipPath]);
  if (listing.code !== 0) {
    throw new ValidationError(`Could not read zip archive: ${listing.stderr}`);
  }
  const entries = listing.stdout.split("\n").filter(Boolean);
  assertSafeEntries(entries);

  // S1: reject an oversized archive from its declared sizes BEFORE
  // extracting anything.
  const declaredSize = await sumDeclaredSize(zipPath);
  if (declaredSize > MAX_CONTEXT_BYTES) {
    throw new ValidationError(
      `Declared build context (${declaredSize} bytes) exceeds the ` +
        `${MAX_CONTEXT_BYTES} byte limit — rejected before extraction.`,
    );
  }

  const contextDir = await mkdtemp(join(tmpdir(), "atelier-image-upload-"));
  try {
    const extract = await run("unzip", ["-q", "-o", zipPath, "-d", contextDir]);
    if (extract.code !== 0) {
      throw new ValidationError(`Failed to unpack zip: ${extract.stderr}`);
    }
    // S2: `unzip` restores symlink entries verbatim — reject any, since a
    // Dockerfile+rootfs upload needs none, before anything downstream (e.g.
    // `readContextDockerfile`) can follow one.
    await assertNoSymlinks(contextDir);
    // Backstop: declared sizes should already have caught an oversized
    // context, but measure the actual result too in case they lied.
    const size = await directorySize(contextDir);
    if (size > MAX_CONTEXT_BYTES) {
      throw new ValidationError(
        `Unpacked build context (${size} bytes) exceeds the ` +
          `${MAX_CONTEXT_BYTES} byte limit.`,
      );
    }
    return contextDir;
  } catch (err) {
    await rm(contextDir, { recursive: true, force: true });
    throw err;
  }
}

/** Recursively walk `dir` and reject if any entry is a symlink. */
async function assertNoSymlinks(dir: string): Promise<void> {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isSymbolicLink()) {
      throw new ValidationError(
        `Zip entry '${entry.name}' is a symlink — rejected.`,
      );
    }
    if (entry.isDirectory()) {
      await assertNoSymlinks(path);
    }
  }
}

async function directorySize(dir: string): Promise<number> {
  const du = await run("du", ["-sk", dir]);
  if (du.code !== 0) return 0;
  const kb = Number.parseInt(du.stdout.split("\t")[0] ?? "0", 10);
  return Number.isFinite(kb) ? kb * 1024 : 0;
}

/** Read `Dockerfile` out of an unpacked context — `buildDockerfile` needs
 * the content separately from `contextDir` (the port's `dockerfile` field is
 * content, not a path; see `builder.types.ts`). Uses `lstat` (not `stat`) so
 * a symlinked Dockerfile is rejected outright rather than followed — belt
 * and braces on top of `unpackZipContext`'s own symlink sweep. */
export async function readContextDockerfile(
  contextDir: string,
): Promise<string> {
  const path = join(contextDir, "Dockerfile");
  const info = await lstat(path).catch(() => undefined);
  if (!info) {
    throw new ValidationError(
      "Uploaded zip does not contain a Dockerfile at its root.",
    );
  }
  if (info.isSymbolicLink()) {
    throw new ValidationError(
      "Uploaded zip's Dockerfile is a symlink — rejected.",
    );
  }
  if (!info.isFile()) {
    throw new ValidationError(
      "Uploaded zip does not contain a Dockerfile at its root.",
    );
  }
  return Bun.file(path).text();
}
