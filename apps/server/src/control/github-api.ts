/**
 * The one place that knows how to call GitHub's REST API: base URL, auth
 * and version headers. Callers own their error mapping (OAuth login, org
 * gating and the repo browser each fail differently).
 */
const GITHUB_API = "https://api.github.com";

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

/** A GitHub call that hangs must not stall a boot, a prebuild or a cron. */
export const GITHUB_TIMEOUT_MS = 10_000;

function githubHeaders(bearer?: string): Record<string, string> {
  return {
    ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}),
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
}

/** `GET {GITHUB_API}{path}` as `token`. `fetchImpl` is injectable for tests. */
export function githubApiGet(
  token: string,
  path: string,
  fetchImpl: FetchLike = fetch,
): Promise<Response> {
  return fetchImpl(`${GITHUB_API}${path}`, {
    headers: githubHeaders(token),
    signal: AbortSignal.timeout(GITHUB_TIMEOUT_MS),
  });
}

/** `GET {GITHUB_API}{path}` without credentials (public endpoints; an App
 * JWT is accepted on `/app` endpoints only). */
export function githubApiGetPublic(
  path: string,
  fetchImpl: FetchLike = fetch,
): Promise<Response> {
  return fetchImpl(`${GITHUB_API}${path}`, {
    headers: githubHeaders(),
    signal: AbortSignal.timeout(GITHUB_TIMEOUT_MS),
  });
}

/** `DELETE {GITHUB_API}{path}` as `bearer`. */
export function githubApiDelete(
  bearer: string,
  path: string,
  fetchImpl: FetchLike = fetch,
): Promise<Response> {
  return fetchImpl(`${GITHUB_API}${path}`, {
    method: "DELETE",
    headers: githubHeaders(bearer),
    signal: AbortSignal.timeout(GITHUB_TIMEOUT_MS),
  });
}

/** `POST {GITHUB_API}{path}` with a JSON body, as `bearer` (a token, or an
 * App JWT). */
export function githubApiPost(
  bearer: string,
  path: string,
  body: unknown,
  fetchImpl: FetchLike = fetch,
): Promise<Response> {
  return fetchImpl(`${GITHUB_API}${path}`, {
    method: "POST",
    headers: { ...githubHeaders(bearer), "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(GITHUB_TIMEOUT_MS),
  });
}
