/**
 * Resolve a repo's branch HEAD from its remote via `git ls-remote`, so the
 * prebuild content key (runtime.service.ts) can detect an upstream git push
 * without cloning. Returns null on any failure so callers decide how to
 * degrade (a prebuild build still runs — only the cache key is affected).
 *
 * An optional GitHub token authenticates PRIVATE remotes (without it, a
 * private repo's `ls-remote` fails with exit 128 and the HEAD drops out of
 * the content key, so the prebuild can never detect drift — and its hash
 * collides across every commit). The token is passed by the request paths
 * that already resolve it (spawn/prebuild); the staleness cron has no user
 * context and passes none, so private repos there stay skipped as before.
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
  githubToken?: string,
): Promise<string | null> {
  // The token is auth material, not part of a remote's identity (it doesn't
  // change HEAD), so it stays out of the cache key — concurrent tokened and
  // tokenless callers still dedupe onto one ls-remote, and a failed (null)
  // resolution evicts itself so a later tokened call can re-resolve a private
  // repo the tokenless one couldn't reach.
  const key = `${url}\u0000${branch ?? ""}`;
  const hit = headCache.get(key);
  if (hit && Date.now() - hit.at < HEAD_CACHE_TTL_MS) return hit.promise;
  // Cache the promise (not the value) so concurrent callers dedupe onto one
  // ls-remote; a null resolution (any failure) evicts itself immediately.
  const promise = lsRemoteHead(url, branch, githubToken).then((head) => {
    if (head === null) headCache.delete(key);
    return head;
  });
  headCache.set(key, { at: Date.now(), promise });
  return promise;
}

async function lsRemoteHead(
  url: string,
  branch?: string,
  githubToken?: string,
): Promise<string | null> {
  const ref = branch ? `refs/heads/${branch}` : "HEAD";
  // Bound the call: a dead host or firewall black-hole makes `git ls-remote`
  // hang on the TCP connect indefinitely. The AbortSignal kills the process on
  // timeout; any failure (timeout, non-zero exit, spawn error) degrades to null.
  try {
    const env: Record<string, string | undefined> = { ...process.env };
    const authArgs: string[] = [];
    if (githubToken) {
      // Authenticate private GitHub remotes WITHOUT leaking the token: it rides
      // an env var read by an inline credential helper (never argv, so it can't
      // be scraped from `ps`), and we only ever log the plain `url` (never the
      // token). The leading empty `credential.helper=` resets any inherited
      // system/global helper first. Mirror the prebuild clone's gitconfig by
      // rewriting ssh GitHub remotes to https so the token helper applies to a
      // `git@github.com:`/`ssh://` clone URL too.
      env.ATELIER_GIT_TOKEN = githubToken;
      authArgs.push(
        "-c",
        "credential.helper=",
        "-c",
        'credential.helper=!f() { printf "username=x-access-token\\npassword=%s\\n" "$ATELIER_GIT_TOKEN"; }; f',
        "-c",
        "url.https://github.com/.insteadOf=git@github.com:",
        "-c",
        "url.https://github.com/.insteadOf=ssh://git@github.com/",
      );
    }
    const proc = Bun.spawn(["git", ...authArgs, "ls-remote", url, ref], {
      env,
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
