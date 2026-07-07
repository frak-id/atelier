/**
 * Resolve a repo's branch HEAD from its remote via `git ls-remote`, so the
 * prebuild content key (runtime.service.ts) can detect an upstream git push
 * without cloning. Returns null on any failure so callers decide how to
 * degrade (a prebuild build still runs — only the cache key is affected).
 */
import { $ } from "bun";
import { createChildLogger } from "../shared/lib/logger.ts";

const log = createChildLogger("git-remote");

export async function getRemoteCommitHash(
  url: string,
  branch?: string,
): Promise<string | null> {
  const ref = branch ? `refs/heads/${branch}` : "HEAD";
  const result = await $`git ls-remote ${url} ${ref}`.quiet().nothrow();

  if (result.exitCode !== 0) {
    log.warn(
      { url, branch, exitCode: result.exitCode },
      "git ls-remote failed",
    );
    return null;
  }

  const output = result.stdout.toString().trim();
  if (!output) return null;
  return output.split("\t")[0] || null;
}
