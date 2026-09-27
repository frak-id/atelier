/** Shallow git operations for the sync job's checkouts. The auth token (if
 * any) only ever appears inside an argv string passed straight to `git` —
 * never in an env var dump or a log line — and every error is redacted
 * before it can bubble up. */

import { mkdir } from "node:fs/promises";

import type { RepoRef } from "./config.ts";
import { redact } from "./config.ts";

export interface GitRunner {
  /** Runs `git`, returns trimmed stdout. Throws (message redacted) on a
   * non-zero exit. */
  run(args: string[], cwd?: string): Promise<string>;
}

/** The real runner, shelling out to the system `git` binary via Bun. */
export const bunGitRunner: GitRunner = {
  async run(args, cwd) {
    const proc = Bun.spawn(["git", ...args], {
      cwd,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    if (exitCode !== 0) {
      throw new Error(`git ${args[0]} failed (${exitCode}): ${stderr.trim()}`);
    }
    return stdout.trim();
  },
};

function authedRemoteUrl(ref: RepoRef, githubToken: string | undefined) {
  const base = `github.com/${ref.owner}/${ref.repo}.git`;
  return githubToken
    ? `https://x-access-token:${githubToken}@${base}`
    : `https://${base}`;
}

/** Cheap remote check (no clone): the branch's current commit sha, without
 * touching disk. Used to skip a repo whose HEAD hasn't moved since last
 * sync. */
export async function remoteHeadSha(
  ref: RepoRef,
  githubToken: string | undefined,
  runner: GitRunner = bunGitRunner,
): Promise<string> {
  const url = authedRemoteUrl(ref, githubToken);
  try {
    const out = await runner.run([
      "ls-remote",
      url,
      `refs/heads/${ref.branch}`,
    ]);
    const sha = out.split(/\s+/)[0];
    if (!sha) {
      throw new Error(`branch "${ref.branch}" not found on remote`);
    }
    return sha;
  } catch (err) {
    throw new Error(
      redact(
        `ls-remote failed for ${ref.owner}/${ref.repo}: ${errorMessage(err)}`,
        [githubToken],
      ),
    );
  }
}

/** Shallow-fetches `ref.branch` into `checkoutDir` (init'd as a git repo if
 * needed) and checks it out. Returns the resulting HEAD sha. */
export async function fetchBranch(
  ref: RepoRef,
  checkoutDir: string,
  githubToken: string | undefined,
  runner: GitRunner = bunGitRunner,
): Promise<string> {
  const url = authedRemoteUrl(ref, githubToken);
  try {
    await mkdir(checkoutDir, { recursive: true });
    await runner.run(["init", "-q", checkoutDir]);
    await runner.run(["fetch", "--depth", "1", url, ref.branch], checkoutDir);
    await runner.run(["checkout", "-q", "FETCH_HEAD"], checkoutDir);
    return await runner.run(["rev-parse", "HEAD"], checkoutDir);
  } catch (err) {
    throw new Error(
      redact(
        `fetch failed for ${ref.owner}/${ref.repo}@${ref.branch}: ` +
          errorMessage(err),
        [githubToken],
      ),
    );
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
