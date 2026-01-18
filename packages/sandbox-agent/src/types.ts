import { t } from "elysia";

export interface SandboxConfig {
  sandboxId: string;
  projectId?: string;
  projectName?: string;
  gitUrl?: string;
  createdAt: string;
  repos?: Array<{ clonePath: string }>;
}

export interface AppPort {
  port: number;
  name: string;
  registeredAt: string;
}

export interface DiscoveredConfig {
  path: string;
  displayPath: string;
  category: "opencode" | "vscode" | "other";
  exists: boolean;
  size?: number;
}

export interface ServiceStatus {
  name: string;
  running: boolean;
  pid?: number;
}

export interface ResourceUsage {
  total: number;
  used: number;
  free: number;
}

export interface ExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface GitRepoStatus {
  path: string;
  branch: string | null;
  dirty: boolean;
  ahead: number;
  behind: number;
  lastCommit: string | null;
  error?: string;
}

export interface ExtensionInstallResult {
  extension: string;
  success: boolean;
  error?: string;
}

export const AppRegistrationSchema = t.Object({
  port: t.Number({ minimum: 1, maximum: 65535 }),
  name: t.String(),
});

export const ExecRequestSchema = t.Object({
  command: t.String(),
  timeout: t.Optional(t.Number({ minimum: 1000, maximum: 300000 })),
});

export const ConfigReadQuerySchema = t.Object({
  path: t.String(),
});

export const ExtensionsInstallSchema = t.Object({
  extensions: t.Array(t.String()),
});
