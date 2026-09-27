/** Shallow git operations for the sync job's checkouts. The auth token (if
 * any) is never embedded in a URL or any other argv value — it would sit in
 * plaintext in `/proc/<pid>/cmdline` for as long as the `git` child process
 * runs. Instead it's supplied out-of-band via `GIT_ASKPASS` (see
 * {@link withGitCredentials}), and any error is still redacted before it can
 * bubble up (in case `git`'s own stderr echoes it back for some reason). */

import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type { RepoRef } from "./config.ts";
import { redact } from "./config.ts";

export interface GitRunOptions {
  cwd?: string;
  env?: Record<string, string>;
}

export interface GitRunner {
  /** Runs `git`, returns trimmed stdout. Throws (message redacted) on a
   * non-zero exit. */
  run(args: string[], opts?: GitRunOptions): Promise<string>;
}

/** The real runner, shelling out to the system `git` binary via Bun. */
export const bunGitRunner: GitRunner = {
  async run(args, opts) {
    const proc = Bun.spawn(["git", ...args], {
      cwd: opts?.cwd,
      env: opts?.env,
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

/** Unauthenticated (or username-only) https remote URL. When a token is
 * given, the URL only ever carries the `x-access-token` username — the
 * token itself is supplied out-of-band via `GIT_ASKPASS`
 * ({@link withGitCredentials}) so it never appears in argv. */
function remoteUrl(ref: RepoRef, githubToken: string | undefined) {
  const base = `github.com/${ref.owner}/${ref.repo}.git`;
  return githubToken ? `https://x-access-token@${base}` : `https://${base}`;
}

const ASKPASS_TOKEN_ENV = "CODEWIKI_GIT_ASKPASS_TOKEN";

/** Runs `fn` with a `git` environment that supplies `githubToken` (if any)
 * through `GIT_ASKPASS` instead of the remote URL: git invokes the askpass
 * script (a tiny shell wrapper written to a private tmp dir, mode 0700, and
 * removed again in the `finally`) to get the password for the
 * `x-access-token` username already in the URL, and the script just prints
 * it from an env var that's never in argv (env vars aren't visible in
 * `/proc/<pid>/cmdline`). `GIT_TERMINAL_PROMPT=0` means a private/missing
 * repo fails cleanly instead of hanging on an interactive prompt — this
 * job's stdin/tty are never attended. */
async function withGitCredentials<T>(
  githubToken: string | undefined,
  fn: (env: Record<string, string>) => Promise<T>,
): Promise<T> {
  const baseEnv: Record<string, string> = {
    ...(process.env as Record<string, string>),
    GIT_TERMINAL_PROMPT: "0",
  };
  if (!githubToken) {
    return fn(baseEnv);
  }
  const askpassDir = await mkdtemp(path.join(tmpdir(), "codewiki-askpass-"));
  const scriptPath = path.join(askpassDir, "askpass.sh");
  try {
    await writeFile(
      scriptPath,
      `#!/bin/sh\nprintf '%s' "$${ASKPASS_TOKEN_ENV}"\n`,
    );
    await chmod(scriptPath, 0o700);
    await chmod(askpassDir, 0o700);
    return await fn({
      ...baseEnv,
      GIT_ASKPASS: scriptPath,
      [ASKPASS_TOKEN_ENV]: githubToken,
    });
  } finally {
    await rm(askpassDir, { recursive: true, force: true });
  }
}

/** Cheap remote check (no clone): the branch's current commit sha, without
 * touching disk. Used to skip a repo whose HEAD hasn't moved since last
 * sync. */
export async function remoteHeadSha(
  ref: RepoRef,
  githubToken: string | undefined,
  runner: GitRunner = bunGitRunner,
): Promise<string> {
  const url = remoteUrl(ref, githubToken);
  try {
    return await withGitCredentials(githubToken, async (env) => {
      const out = await runner.run(
        ["ls-remote", url, `refs/heads/${ref.branch}`],
        { env },
      );
      const sha = out.split(/\s+/)[0];
      if (!sha) {
        throw new Error(`branch "${ref.branch}" not found on remote`);
      }
      return sha;
    });
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
  const url = remoteUrl(ref, githubToken);
  try {
    await mkdir(checkoutDir, { recursive: true });
    return await withGitCredentials(githubToken, async (env) => {
      await runner.run(["init", "-q", checkoutDir], { env });
      await runner.run(["fetch", "--depth", "1", url, ref.branch], {
        cwd: checkoutDir,
        env,
      });
      await runner.run(["checkout", "-q", "FETCH_HEAD"], {
        cwd: checkoutDir,
        env,
      });
      return await runner.run(["rev-parse", "HEAD"], {
        cwd: checkoutDir,
        env,
      });
    });
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
