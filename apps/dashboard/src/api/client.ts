import { treaty } from "@elysiajs/eden";
import type { App as ManagerApp } from "@frak-sandbox/manager";

export const API_HOST = import.meta.env.PROD
  ? "https://sandbox-api.nivelais.com"
  : "http://localhost:4000";

export const AUTH_TOKEN_KEY = "frak_sandbox_jwt";

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
  Workspace,
} from "@frak-sandbox/manager/types";

type GitHubReposResponse = Awaited<
  ReturnType<typeof api.api.github.repos.get>
>["data"];
export type GitHubRepository =
  NonNullable<GitHubReposResponse>["repositories"][number];
