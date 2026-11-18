/**
 * GitHub's rate limits, as its REST and GraphQL APIs tell them. A request
 * refused for one did nothing, so github.ts sends it again once the limit
 * allows, whatever its method.
 */

/** Past this wait the run fails rather than hold its runner: a primary limit
 * can take up to an hour to reset. */
export const MAX_RATE_LIMIT_WAIT_MS = 5 * 60_000;

/**
 * How long GitHub asks to wait before a refused request is sent again, or
 * undefined when the refusal isn't a rate limit: `retry-after` first, then the
 * primary limit's reset, then a minute for a secondary limit that says neither
 * (GitHub's docs).
 */
export function rateLimitWait(
  response: { status: number; headers: Headers },
  body: string,
  now = Date.now(),
): number | undefined {
  if (response.status !== 403 && response.status !== 429) return undefined;
  const retryAfter = response.headers.get("retry-after")?.trim();
  if (retryAfter && /^\d+$/.test(retryAfter)) return Number(retryAfter) * 1000;
  if (response.headers.get("x-ratelimit-remaining") === "0") {
    const reset = Number(response.headers.get("x-ratelimit-reset"));
    if (Number.isFinite(reset) && reset > 0)
      return Math.max(reset * 1000 - now, 0) + 1_000;
  }
  return /rate limit/i.test(body) ? 60_000 : undefined;
}
