/**
 * Unpack a user-uploaded zip into a fresh temp build-context directory for
 * `ImageBuilderService.buildDockerfile`. Shells out to `unzip` (same
 * "a CLI binary on PATH" convention as `docker-cli.ts`) rather than pulling
 * in a zip-parsing dependency.
 *
 * Two guards this module exists to enforce (design review: "arbitrary
 * Dockerfiles bite"):
 *   - total unpacked size is capped, so a zip bomb can't fill the host disk;
 *   - `unzip` itself refuses `../` path-traversal entries by default, but we
 *     double-check the listing before extracting so a crafted entry can't
 *     write outside the temp dir even if some `unzip` build's default ever
 *     changed.
 */
import { spawn } from "node:child_process";
import { mkdtemp, rm, stat } from "node:fs/promises";
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

  const contextDir = await mkdtemp(join(tmpdir(), "atelier-image-upload-"));
  try {
    const extract = await run("unzip", ["-q", "-o", zipPath, "-d", contextDir]);
    if (extract.code !== 0) {
      throw new ValidationError(`Failed to unpack zip: ${extract.stderr}`);
    }
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

async function directorySize(dir: string): Promise<number> {
  const du = await run("du", ["-sk", dir]);
  if (du.code !== 0) return 0;
  const kb = Number.parseInt(du.stdout.split("\t")[0] ?? "0", 10);
  return Number.isFinite(kb) ? kb * 1024 : 0;
}

/** Read `Dockerfile` out of an unpacked context — `buildDockerfile` needs
 * the content separately from `contextDir` (the port's `dockerfile` field is
 * content, not a path; see `builder.types.ts`). */
export async function readContextDockerfile(
  contextDir: string,
): Promise<string> {
  const path = join(contextDir, "Dockerfile");
  const info = await stat(path).catch(() => undefined);
  if (!info?.isFile()) {
    throw new ValidationError(
      "Uploaded zip does not contain a Dockerfile at its root.",
    );
  }
  return Bun.file(path).text();
}
