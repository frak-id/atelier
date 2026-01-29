import { config } from "./config.ts";

const GITHUB_AUTHORIZE_URL = "https://github.com/login/oauth/authorize";
const GITHUB_TOKEN_URL = "https://github.com/login/oauth/access_token";
const GITHUB_USER_URL = "https://api.github.com/user";

export interface GitHubUser {
  id: number;
  login: string;
  avatar_url: string;
}

export async function exchangeCodeForToken(code: string): Promise<string> {
  const response = await fetch(GITHUB_TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({
      client_id: config.github.clientId,
      client_secret: config.github.clientSecret,
      code,
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
  const response = await fetch(GITHUB_USER_URL, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });

  if (!response.ok) {
    throw new Error(`GitHub user fetch failed: ${response.status}`);
  }

  return response.json() as Promise<GitHubUser>;
}

export function buildOAuthRedirectUrl(
  callbackUrl: string,
  scopes: string,
  extraParams?: Record<string, string>,
): string {
  if (!config.github.clientId) {
    throw new Error("GitHub OAuth not configured");
  }

  const params = new URLSearchParams({
    client_id: config.github.clientId,
    redirect_uri: callbackUrl,
    scope: scopes,
    ...extraParams,
  });

  return `${GITHUB_AUTHORIZE_URL}?${params.toString()}`;
}
