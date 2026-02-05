import { treaty } from "@elysiajs/eden";
import type { App as ManagerApp } from "@frak/atelier-manager";

export const api = treaty<ManagerApp>(window.location.origin, {
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
  ManagerEvent,
  Sandbox,
  SshKey,
  StorageStatus,
  SystemStats,
  Task,
  Workspace,
} from "@frak/atelier-manager/types";
