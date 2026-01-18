export type SandboxStatus = "creating" | "running" | "stopped" | "error";

export interface SandboxUrls {
  vscode: string;
  opencode: string;
  terminal: string;
  ssh: string;
}

export interface SandboxRuntime {
  ipAddress: string;
  macAddress: string;
  urls: SandboxUrls;
  vcpus: number;
  memoryMb: number;
  pid?: number;
  error?: string;
}

export interface Sandbox {
  id: string;
  workspaceId?: string;
  status: SandboxStatus;
  runtime: SandboxRuntime;
  createdAt: string;
  updatedAt: string;
}

export interface CreateSandboxOptions {
  workspaceId?: string;
  baseImage?: string;
  vcpus?: number;
  memoryMb?: number;
}

export interface SandboxListFilters {
  status?: SandboxStatus;
  workspaceId?: string;
}
