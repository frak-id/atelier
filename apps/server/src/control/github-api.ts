/**
 * The one place that knows how to call GitHub's REST API: base URL, auth
 * and version headers. Callers own their error mapping (OAuth login, org
 * gating and the repo browser each fail differently).
 */
const GITHUB_API = "https://api.github.com";

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

/** `GET {GITHUB_API}{path}` as `token`. `fetchImpl` is injectable for tests. */
export function githubApiGet(
  token: string,
  path: string,
  fetchImpl: FetchLike = fetch,
): Promise<Response> {
  return fetchImpl(`${GITHUB_API}${path}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });
}
