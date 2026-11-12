import { config, isAuthBypassed } from "../shared/lib/config.ts";
import { createChildLogger } from "../shared/lib/logger.ts";
import { type FetchLike, githubApiGet } from "./github-api.ts";

const log = createChildLogger("github");

const GITHUB_AUTHORIZE_URL = "https://github.com/login/oauth/authorize";
const GITHUB_TOKEN_URL = "https://github.com/login/oauth/access_token";

export interface GitHubUser {
  id: number;
  login: string;
  avatar_url: string;
}

export function generateCodeVerifier(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

export async function generateCodeChallenge(verifier: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(verifier);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return btoa(String.fromCharCode(...new Uint8Array(digest)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

export async function exchangeCodeForToken(
  code: string,
  codeVerifier?: string,
): Promise<string> {
  if (isAuthBypassed()) {
    log.debug("Auth bypassed: returning mock access token");
    return `mock-access-token-${code}`;
  }

  const response = await fetch(GITHUB_TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({
      client_id: config.auth.github.clientId,
      client_secret: config.auth.github.clientSecret,
      code,
      ...(codeVerifier && { code_verifier: codeVerifier }),
    }),
  });

  if (!response.ok) {
    throw new Error(`GitHub token exchange failed: ${response.status}`);
  }

  const data = (await response.json()) as {
    access_token?: string;
    error?: string;
  };
  if (data.error || !data.access_token) {
    throw new Error(data.error || "No access token received");
  }

  return data.access_token;
}

export async function fetchGitHubUser(
  accessToken: string,
): Promise<GitHubUser> {
  if (isAuthBypassed()) {
    log.debug("Auth bypassed: returning mock GitHub user");
    return {
      id: 12345,
      login: "mock-user",
      avatar_url: "https://avatars.githubusercontent.com/u/1?v=4",
    };
  }

  const response = await githubApiGet(accessToken, "/user");

  if (!response.ok) {
    throw new Error(`GitHub user fetch failed: ${response.status}`);
  }

  return response.json() as Promise<GitHubUser>;
}

/** What GitHub says about a stored OAuth token. */
export type GitHubTokenStatus = "valid" | "revoked" | "unknown";

/**
 * Whether GitHub still accepts `accessToken`. Only a 401 means `revoked`
 * (the user revoked the app, the token expired or GitHub killed it); a rate
 * limit, an SSO block, an outage or a timeout is `unknown`, never a reason to
 * sign anyone out.
 */
export async function checkGitHubToken(
  accessToken: string,
  fetchImpl?: FetchLike,
): Promise<GitHubTokenStatus> {
  try {
    const response = await githubApiGet(accessToken, "/user", fetchImpl);
    if (response.status === 401) return "revoked";
    return response.ok ? "valid" : "unknown";
  } catch (err) {
    log.warn(
      { err: err instanceof Error ? err.message : "unknown" },
      "could not check a GitHub token",
    );
    return "unknown";
  }
}

export function buildOAuthRedirectUrl(
  callbackUrl: string,
  scopes: string,
  extraParams?: Record<string, string>,
): string {
  if (!config.auth.github.clientId) {
    throw new Error("GitHub OAuth not configured");
  }

  const params = new URLSearchParams({
    client_id: config.auth.github.clientId,
    redirect_uri: callbackUrl,
    scope: scopes,
    ...extraParams,
  });

  return `${GITHUB_AUTHORIZE_URL}?${params.toString()}`;
}
