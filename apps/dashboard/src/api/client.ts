import { treaty } from "@elysiajs/eden";
import type { App as ManagerApp } from "@frak-sandbox/manager";
import { API_URL } from "@/config";

export const API_HOST = API_URL || "http://localhost:4000";

export const api = treaty<ManagerApp>(API_HOST, {
  fetch: { credentials: "include" },
});

export async function checkAuth() {
  const { data, error } = await api.auth.me.get();
  if (error) return null;
  return data;
}

export async function logout() {
  await api.auth.logout.post();
}

export type {
  BaseImage,
  ConfigFile,
  ConfigFileContentType,
  FileSecret,
  HealthStatus,
  Sandbox,
  SshKey,
  StorageStatus,
  SystemStats,
  Task,
  Workspace,
} from "@frak-sandbox/manager/types";

type GitHubReposResponse = Awaited<
  ReturnType<typeof api.api.github.repos.get>
>["data"];
export type GitHubRepository =
  NonNullable<GitHubReposResponse>["repositories"][number];
