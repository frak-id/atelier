import { treaty } from "@elysiajs/eden";
import type { App as ManagerApp } from "@frak-sandbox/manager";
import { API_URL } from "@/config";

export const API_HOST = API_URL || "http://localhost:4000";

const AUTH_TOKEN_KEY = "frak_sandbox_jwt";

export function getAuthToken(): string | null {
  return localStorage.getItem(AUTH_TOKEN_KEY);
}

export function setAuthToken(token: string): void {
  localStorage.setItem(AUTH_TOKEN_KEY, token);
}

export function clearAuthToken(): void {
  localStorage.removeItem(AUTH_TOKEN_KEY);
}

export const api = treaty<ManagerApp>(API_HOST, {
  headers: (): Record<string, string> => {
    const token = getAuthToken();
    if (!token) return {};
    return { Authorization: `Bearer ${token}` };
  },
});

export type {
  ConfigFile,
  ConfigFileContentType,
  FileSecret,
  Sandbox,
  SshKey,
  Workspace,
} from "@frak-sandbox/manager/types";

type GitHubReposResponse = Awaited<
  ReturnType<typeof api.api.github.repos.get>
>["data"];
export type GitHubRepository =
  NonNullable<GitHubReposResponse>["repositories"][number];
