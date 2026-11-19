/**
 * GitHub's REST and GraphQL APIs, on one repository, with the job's token. A
 * rate limit is waited out (rate-limit.ts), and a GET is sent again after a
 * network or server error.
 */
import { MAX_RATE_LIMIT_WAIT_MS, rateLimitWait } from "./rate-limit.ts";

/** GitHub's GETs are sent again after a network or server error. */
const RETRY_DELAYS_MS = [5_000, 15_000];
/** How many times one request waits out a rate limit before the run fails. */
const RATE_LIMIT_RETRIES = 3;

/** A GitHub request that failed: its status, if GitHub answered, and the wait
 * a rate limit asks for. */
export class GitHubError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly retryAfterMs?: number,
  ) {
    super(message);
  }
}

/** The status GitHub answered a failed request with, if it answered. */
export const statusOf = (error: unknown): number | undefined =>
  (error as { status?: number }).status;

/**
 * Sends a GitHub request (`send`, called again for each attempt). A rate limit
 * is waited out, up to RATE_LIMIT_RETRIES times and MAX_RATE_LIMIT_WAIT_MS each:
 * the refused request did nothing, so any request is sent again, a POST too.
 * After a network or server error, it's sent again after each of `delays`: only
 * a GET's are given, since anything else may have been done.
 */
export async function sendWithRetries<T>(
  label: string,
  send: () => Promise<T>,
  delays: readonly number[],
  log: (message: string) => void,
  sleep = (ms: number) => Bun.sleep(ms),
): Promise<T> {
  let failures = 0;
  let limited = 0;
  for (;;) {
    try {
      return await send();
    } catch (error) {
      const { status, retryAfterMs } = error as Partial<GitHubError>;
      if (
        retryAfterMs !== undefined &&
        retryAfterMs <= MAX_RATE_LIMIT_WAIT_MS &&
        limited < RATE_LIMIT_RETRIES
      ) {
        limited++;
        log(
          `GitHub rate limit on ${label}: sending it again in ${Math.ceil(retryAfterMs / 1000)} s`,
        );
        await sleep(retryAfterMs);
        continue;
      }
      const delay = delays[failures++];
      // A refusal (4xx) won't change; a network error or a 5xx may.
      if (delay === undefined || (status !== undefined && status < 500))
        throw error;
      log(
        `GitHub ${label} failed (${(error as Error).message}), retrying in ${delay / 1000} s`,
      );
      await sleep(delay);
    }
  }
}

export interface GitHub {
  /** A request to `/repos/<repository><path>`: its JSON, or undefined for a
   * 204. */
  request<T>(path: string, init?: RequestInit): Promise<T>;
  /** Every page of a list under the repository. */
  all<T>(path: string): Promise<T[]>;
  graphql<T>(query: string, variables: Record<string, unknown>): Promise<T>;
}

/** The API of `repository` (owner/name), with `token`. */
export function gitHub(options: {
  repository: string;
  token: string;
  log: (message: string) => void;
}): GitHub {
  const { repository, token, log } = options;

  async function requestOnce<T>(path: string, init: RequestInit): Promise<T> {
    const response = await fetch(
      `https://api.github.com/repos/${repository}${path}`,
      {
        ...init,
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
          ...init.headers,
        },
        signal: AbortSignal.timeout(60_000),
      },
    );
    if (!response.ok) {
      const text = await response.text();
      throw new GitHubError(
        `GitHub ${init.method ?? "GET"} ${path}: ${response.status} ${text}`,
        response.status,
        rateLimitWait(response, text),
      );
    }
    // A DELETE answers 204, with no body.
    return (response.status === 204 ? undefined : await response.json()) as T;
  }

  function request<T>(path: string, init: RequestInit = {}): Promise<T> {
    return sendWithRetries(
      `${init.method ?? "GET"} ${path}`,
      () => requestOnce<T>(path, init),
      init.method === undefined ? RETRY_DELAYS_MS : [],
      log,
    );
  }

  async function graphqlOnce<T>(
    query: string,
    variables: Record<string, unknown>,
  ): Promise<T> {
    const response = await fetch("https://api.github.com/graphql", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ query, variables }),
      signal: AbortSignal.timeout(60_000),
    });
    const text = await response.text();
    let result: { data?: T; errors?: { type?: string; message: string }[] } =
      {};
    try {
      result = JSON.parse(text);
    } catch {}
    if (!response.ok || result.errors?.length || result.data === undefined) {
      // The primary limit answers 200, with a RATE_LIMITED error.
      const limited = result.errors?.some((e) => e.type === "RATE_LIMITED");
      throw new GitHubError(
        `GitHub GraphQL: ${response.status} ${result.errors?.map((e) => e.message).join("; ") ?? text}`,
        response.status,
        limited
          ? rateLimitWait({ status: 429, headers: response.headers }, text)
          : rateLimitWait(response, text),
      );
    }
    return result.data;
  }

  return {
    request,
    async all<T>(path: string): Promise<T[]> {
      const items: T[] = [];
      const separator = path.includes("?") ? "&" : "?";
      for (let page = 1; ; page++) {
        const batch = await request<T[]>(
          `${path}${separator}per_page=100&page=${page}`,
        );
        items.push(...batch);
        if (batch.length < 100) return items;
      }
    },
    graphql<T>(query: string, variables: Record<string, unknown>) {
      return sendWithRetries(
        "GraphQL",
        () => graphqlOnce<T>(query, variables),
        [],
        log,
      );
    },
  };
}
