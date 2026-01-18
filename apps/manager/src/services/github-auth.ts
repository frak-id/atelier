import { nanoid } from "nanoid";
import { config } from "../lib/config.ts";
import { createChildLogger } from "../lib/logger.ts";
import {
  type GitHubConnection,
  GitHubConnectionRepository,
} from "../state/database.ts";
import { SecretsService } from "./secrets.ts";

const log = createChildLogger("github-auth");

const GITHUB_AUTHORIZE_URL = "https://github.com/login/oauth/authorize";
const GITHUB_TOKEN_URL = "https://github.com/login/oauth/access_token";
const GITHUB_USER_URL = "https://api.github.com/user";

export interface GitHubUser {
  id: number;
  login: string;
  avatar_url: string;
  name?: string;
  email?: string;
}

export interface GitHubTokenResponse {
  access_token: string;
  token_type: string;
  scope: string;
  error?: string;
  error_description?: string;
}

export interface GitHubConnectionStatus {
  connected: boolean;
  user?: {
    login: string;
    avatarUrl: string;
  };
}

export const GitHubAuthService = {
  getAuthorizationUrl(): { url: string; state: string } {
    const state = nanoid(32);

    const params = new URLSearchParams({
      client_id: config.github.clientId,
      redirect_uri: config.github.callbackUrl,
      scope: "repo user:email",
      state,
    });

    const url = `${GITHUB_AUTHORIZE_URL}?${params.toString()}`;
    log.debug({ state }, "Generated GitHub authorization URL");

    return { url, state };
  },

  async exchangeCodeForToken(code: string): Promise<GitHubTokenResponse> {
    log.debug("Exchanging authorization code for access token");

    const response = await fetch(GITHUB_TOKEN_URL, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        client_id: config.github.clientId,
        client_secret: config.github.clientSecret,
        code,
      }),
    });

    if (!response.ok) {
      const text = await response.text();
      log.error(
        { status: response.status, body: text },
        "Token exchange failed",
      );
      throw new Error(`Failed to exchange code: ${response.status}`);
    }

    const data = (await response.json()) as GitHubTokenResponse;

    if (data.error) {
      log.error(
        { error: data.error, description: data.error_description },
        "GitHub returned error",
      );
      throw new Error(data.error_description || data.error);
    }

    log.info({ scope: data.scope }, "Successfully exchanged code for token");
    return data;
  },

  async getUser(accessToken: string): Promise<GitHubUser> {
    const response = await fetch(GITHUB_USER_URL, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
    });

    if (!response.ok) {
      const text = await response.text();
      log.error({ status: response.status }, "Failed to fetch GitHub user");
      throw new Error(`Failed to fetch user: ${response.status} - ${text}`);
    }

    const user = (await response.json()) as GitHubUser;
    log.debug({ login: user.login, id: user.id }, "Fetched GitHub user");
    return user;
  },

  async saveConnection(
    user: GitHubUser,
    accessToken: string,
    scope: string,
  ): Promise<GitHubConnection> {
    const encryptedToken = await SecretsService.encrypt(accessToken);
    const now = new Date().toISOString();

    const existing = GitHubConnectionRepository.getByGitHubUserId(
      String(user.id),
    );

    if (existing) {
      log.info({ login: user.login }, "Updating existing GitHub connection");
      return GitHubConnectionRepository.update(existing.id, {
        githubUsername: user.login,
        avatarUrl: user.avatar_url,
        accessToken: encryptedToken,
        scope,
      });
    }

    const connection: GitHubConnection = {
      id: nanoid(12),
      githubUserId: String(user.id),
      githubUsername: user.login,
      avatarUrl: user.avatar_url,
      accessToken: encryptedToken,
      scope,
      createdAt: now,
      updatedAt: now,
    };

    log.info({ login: user.login }, "Creating new GitHub connection");
    return GitHubConnectionRepository.create(connection);
  },

  async getConnection(): Promise<GitHubConnection | null> {
    const connection = GitHubConnectionRepository.get();
    return connection ?? null;
  },

  async getDecryptedToken(): Promise<string | null> {
    const connection = await this.getConnection();
    if (!connection) return null;

    return SecretsService.decrypt(connection.accessToken);
  },

  async getConnectionStatus(): Promise<GitHubConnectionStatus> {
    const connection = await this.getConnection();

    if (!connection) {
      return { connected: false };
    }

    return {
      connected: true,
      user: {
        login: connection.githubUsername,
        avatarUrl: connection.avatarUrl ?? "",
      },
    };
  },

  async deleteConnection(): Promise<boolean> {
    const connection = await this.getConnection();
    if (!connection) {
      log.warn("Attempted to delete non-existent GitHub connection");
      return false;
    }

    GitHubConnectionRepository.delete(connection.id);
    log.info({ login: connection.githubUsername }, "GitHub connection deleted");
    return true;
  },

  async validateToken(accessToken: string): Promise<boolean> {
    try {
      const response = await fetch(GITHUB_USER_URL, {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          Accept: "application/vnd.github+json",
        },
      });
      return response.ok;
    } catch {
      return false;
    }
  },
};
