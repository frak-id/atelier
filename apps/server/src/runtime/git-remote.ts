/**
 * Resolve a repo's branch HEAD from its remote via `git ls-remote`, so the
 * prebuild content key (runtime.service.ts) can detect an upstream git push
 * without cloning. Returns null on any failure so callers decide how to
 * degrade (a prebuild build still runs — only the cache key is affected).
 */
import { createChildLogger } from "../shared/lib/logger.ts";

const log = createChildLogger("git-remote");

const LS_REMOTE_TIMEOUT_MS = 5_000;
// Short TTL cache: spawn-from-prebuild resolves the content key on the
// request path, paying up-to-5s of ls-remote per repo. 30s of staleness is
// harmless there (the staleness cron rebuilds drifted prebuilds anyway), and
// the cron's 30-min cadence means it always misses the cache — it stays
// effectively uncached. Failures are not cached so a transient network blip
// doesn't pin `null` for the TTL.
const HEAD_CACHE_TTL_MS = 30_000;
const headCache = new Map<
  string,
  { at: number; promise: Promise<string | null> }
>();

export function getRemoteCommitHash(
  url: string,
  branch?: string,
): Promise<string | null> {
  const key = `${url}\u0000${branch ?? ""}`;
  const hit = headCache.get(key);
  if (hit && Date.now() - hit.at < HEAD_CACHE_TTL_MS) return hit.promise;
  // Cache the promise (not the value) so concurrent callers dedupe onto one
  // ls-remote; a null resolution (any failure) evicts itself immediately.
  const promise = lsRemoteHead(url, branch).then((head) => {
    if (head === null) headCache.delete(key);
    return head;
  });
  headCache.set(key, { at: Date.now(), promise });
  return promise;
}

async function lsRemoteHead(
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
