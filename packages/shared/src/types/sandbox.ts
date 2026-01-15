/**
 * Sandbox type definitions
 */

export type SandboxStatus = "creating" | "running" | "stopped" | "error";

export interface SandboxUrls {
  /** VSCode Server URL */
  vscode: string;
  /** OpenCode URL */
  opencode: string;
  /** SSH connection string */
  ssh: string;
}

export interface SandboxResources {
  /** Number of virtual CPUs */
  vcpus: number;
  /** Memory in megabytes */
  memoryMb: number;
}

export interface Sandbox {
  /** Unique sandbox identifier */
  id: string;
  /** Current status */
  status: SandboxStatus;
  /** Associated project ID (optional) */
  projectId?: string;
  /** Git branch name */
  branch?: string;
  /** Internal IP address */
  ipAddress: string;
  /** MAC address */
  macAddress: string;
  /** External URLs */
  urls: SandboxUrls;
  /** Allocated resources */
  resources: SandboxResources;
  /** Firecracker process ID */
  pid?: number;
  /** Creation timestamp */
  createdAt: string;
  /** Last updated timestamp */
  updatedAt: string;
  /** Error message if status is 'error' */
  error?: string;
}

export interface CreateSandboxOptions {
  /** Optional custom ID */
  id?: string;
  /** Project ID to clone */
  projectId?: string;
  /** Git branch to checkout */
  branch?: string;
  /** Number of vCPUs (default: 2) */
  vcpus?: number;
  /** Memory in MB (default: 2048) */
  memoryMb?: number;
}

export interface SandboxListFilters {
  /** Filter by status */
  status?: SandboxStatus;
  /** Filter by project ID */
  projectId?: string;
}
