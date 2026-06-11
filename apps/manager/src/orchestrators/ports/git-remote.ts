import { $ } from "bun";
import type { RepoConfig } from "../../schemas/index.ts";
import { createChildLogger } from "../../shared/lib/logger.ts";
import { buildAuthenticatedGitUrl } from "./guest-repo.ts";

const log = createChildLogger("git-remote");

/**
 * Resolve a repo's branch HEAD from its remote via `git ls-remote` on the
 * manager host. Shared by prebuild staleness checks and mock-mode hash
 * capture. Returns null on any failure so callers decide how to degrade.
 */
export async function getRemoteCommitHash(
  repo: RepoConfig,
  githubAccessToken?: string,
): Promise<string | null> {
  const gitUrl = buildAuthenticatedGitUrl(repo.url, githubAccessToken);
  const result = await $`git ls-remote ${gitUrl} refs/heads/${repo.branch}`
    .quiet()
    .nothrow();

  if (result.exitCode !== 0) {
    log.warn(
      { branch: repo.branch, exitCode: result.exitCode },
      "git ls-remote failed",
    );
    return null;
  }

  const output = result.stdout.toString().trim();
  if (!output) return null;
  return output.split("\t")[0] || null;
}
