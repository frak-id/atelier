/**
 * Resolve a repo's branch HEAD from its remote via `git ls-remote`, so the
 * prebuild content key (runtime.service.ts) can detect an upstream git push
 * without cloning. Returns null on any failure so callers decide how to
 * degrade (a prebuild build still runs — only the cache key is affected).
 */
import { createChildLogger } from "../shared/lib/logger.ts";

const log = createChildLogger("git-remote");

const LS_REMOTE_TIMEOUT_MS = 5_000;

export async function getRemoteCommitHash(
  url: string,
  branch?: string,
): Promise<string | null> {
  const ref = branch ? `refs/heads/${branch}` : "HEAD";
  // Bound the call: a dead host or firewall black-hole makes `git ls-remote`
  // hang on the TCP connect indefinitely. The AbortSignal kills the process on
  // timeout; any failure (timeout, non-zero exit, spawn error) degrades to null.
  try {
    const proc = Bun.spawn(["git", "ls-remote", url, ref], {
      stdout: "pipe",
      stderr: "ignore",
      signal: AbortSignal.timeout(LS_REMOTE_TIMEOUT_MS),
    });
    const [exitCode, stdout] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).text(),
    ]);
    if (exitCode !== 0) {
      log.warn({ url, branch, exitCode }, "git ls-remote failed");
      return null;
    }
    const output = stdout.trim();
    if (!output) return null;
    return output.split("\t")[0] || null;
  } catch (err) {
    log.warn({ url, branch, err }, "git ls-remote failed");
    return null;
  }
}
