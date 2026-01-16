const API_BASE = import.meta.env.PROD ? "https://sandbox-api.nivelais.com" : "";

type RequestOptions = {
  method?: "GET" | "POST" | "PUT" | "DELETE";
  body?: unknown;
  params?: Record<string, string | undefined>;
};

async function request<T>(
  endpoint: string,
  options: RequestOptions = {},
): Promise<T> {
  const { method = "GET", body, params } = options;

  let url = `${API_BASE}${endpoint}`;
  if (params) {
    const searchParams = new URLSearchParams();
    Object.entries(params).forEach(([key, value]) => {
      if (value !== undefined) {
        searchParams.append(key, value);
      }
    });
    const queryString = searchParams.toString();
    if (queryString) {
      url += `?${queryString}`;
    }
  }

  const response = await fetch(url, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });

  if (!response.ok) {
    const error = await response
      .json()
      .catch(() => ({ message: "Unknown error" }));
    throw new Error(error.message || `HTTP ${response.status}`);
  }

  if (response.status === 204) {
    return null as T;
  }

  return response.json();
}

export const api = {
  health: {
    get: () => request<HealthStatus>("/health"),
    live: () => request<{ status: "ok" }>("/health/live"),
    ready: () => request<{ status: string; reason?: string }>("/health/ready"),
  },

  sandboxes: {
    list: (params?: { status?: string; projectId?: string }) =>
      request<Sandbox[]>("/api/sandboxes", { params }),
    get: (id: string) => request<Sandbox>(`/api/sandboxes/${id}`),
    create: (data: CreateSandboxOptions) =>
      request<Sandbox | JobResponse>("/api/sandboxes", {
        method: "POST",
        body: data,
      }),
    delete: (id: string) =>
      request<null>(`/api/sandboxes/${id}`, { method: "DELETE" }),
    stop: (id: string) =>
      request<Sandbox>(`/api/sandboxes/${id}/stop`, { method: "POST" }),
    start: (id: string) =>
      request<Sandbox>(`/api/sandboxes/${id}/start`, { method: "POST" }),
    getJob: (id: string) => request<JobResponse>(`/api/sandboxes/job/${id}`),
    health: (id: string) => request<AgentHealth>(`/api/sandboxes/${id}/health`),
    metrics: (id: string) =>
      request<AgentMetrics>(`/api/sandboxes/${id}/metrics`),
    apps: (id: string) => request<App[]>(`/api/sandboxes/${id}/apps`),
    registerApp: (id: string, data: { port: number; name: string }) =>
      request(`/api/sandboxes/${id}/apps`, { method: "POST", body: data }),
    exec: (id: string, data: { command: string; timeout?: number }) =>
      request<ExecResult>(`/api/sandboxes/${id}/exec`, {
        method: "POST",
        body: data,
      }),
    logs: (id: string, service: string, lines?: number) =>
      request<{ logs: string }>(`/api/sandboxes/${id}/logs/${service}`, {
        params: { lines: lines?.toString() },
      }),
    services: (id: string) =>
      request<ServiceStatus[]>(`/api/sandboxes/${id}/services`),
  },

  projects: {
    list: (params?: { prebuildStatus?: string }) =>
      request<Project[]>("/api/projects", { params }),
    get: (id: string) => request<Project>(`/api/projects/${id}`),
    create: (data: CreateProjectOptions) =>
      request<Project>("/api/projects", { method: "POST", body: data }),
    update: (id: string, data: UpdateProjectOptions) =>
      request<Project>(`/api/projects/${id}`, { method: "PUT", body: data }),
    delete: (id: string) =>
      request<null>(`/api/projects/${id}`, { method: "DELETE" }),
    triggerPrebuild: (id: string) =>
      request<{ message: string; projectId: string }>(
        `/api/projects/${id}/prebuild`,
        {
          method: "POST",
        },
      ),
  },

  images: {
    list: (all?: boolean) =>
      request<BaseImage[]>("/api/images", {
        params: { all: all ? "true" : undefined },
      }),
    get: (id: string) => request<BaseImage>(`/api/images/${id}`),
  },

  system: {
    stats: () => request<SystemStats>("/api/system/stats"),
    storage: () => request<StorageStats>("/api/system/storage"),
    queue: () => request<QueueStats>("/api/system/queue"),
    cleanup: () =>
      request<CleanupResult>("/api/system/cleanup", { method: "POST" }),
  },
};

export interface HealthStatus {
  status: "ok" | "degraded" | "error";
  uptime: number;
  timestamp: number;
  checks: {
    firecracker: "ok" | "error";
    caddy: "ok" | "error";
    network: "ok" | "error";
    storage: "ok" | "error";
    lvm: "ok" | "unavailable";
  };
}

export interface Sandbox {
  id: string;
  status: "creating" | "running" | "stopped" | "error";
  projectId?: string;
  branch?: string;
  ipAddress: string;
  macAddress: string;
  urls: { vscode: string; opencode: string; ssh: string };
  resources: { vcpus: number; memoryMb: number };
  pid?: number;
  createdAt: string;
  updatedAt: string;
  error?: string;
}

export interface CreateSandboxOptions {
  id?: string;
  projectId?: string;
  baseImage?: string;
  branch?: string;
  vcpus?: number;
  memoryMb?: number;
  async?: boolean;
}

export interface JobResponse {
  id: string;
  status: "queued" | "running" | "completed" | "failed";
  queuedAt: string;
  startedAt?: string;
  completedAt?: string;
  error?: string;
  result?: Sandbox;
}

export interface Project {
  id: string;
  name: string;
  gitUrl: string;
  defaultBranch: string;
  baseImage: string;
  vcpus: number;
  memoryMb: number;
  initCommands: string[];
  startCommands: string[];
  secrets: Record<string, string>;
  exposedPorts: number[];
  latestPrebuildId?: string;
  prebuildStatus: "none" | "building" | "ready" | "failed";
  createdAt: string;
  updatedAt: string;
}

export interface CreateProjectOptions {
  name: string;
  gitUrl: string;
  defaultBranch?: string;
  baseImage?: string;
  vcpus?: number;
  memoryMb?: number;
  initCommands?: string[];
  startCommands?: string[];
  secrets?: Record<string, string>;
  exposedPorts?: number[];
}

export type UpdateProjectOptions = Partial<CreateProjectOptions>;

export interface BaseImage {
  id: string;
  name: string;
  description: string;
  volumeSize: number;
  tools: string[];
  volumeName: string;
  available: boolean;
}

export interface SystemStats {
  cpuUsage: number;
  memoryUsed: number;
  memoryTotal: number;
  memoryPercent: number;
  diskUsed: number;
  diskTotal: number;
  diskPercent: number;
  activeSandboxes: number;
  maxSandboxes: number;
  uptime: number;
}

export interface StorageStats {
  available: boolean;
  hasBaseVolume: boolean;
  pool: {
    exists: boolean;
    dataPercent: number;
    metadataPercent: number;
    totalSize: string;
    usedSize: string;
    volumeCount: number;
  };
}

export interface QueueStats {
  stats: {
    queued: number;
    running: number;
    completed: number;
    failed: number;
    maxConcurrent: number;
  };
  queued: { id: string; projectId?: string; queuedAt: string }[];
  running: { id: string; projectId?: string; startedAt?: string }[];
}

export interface CleanupResult {
  socketsRemoved: number;
  overlaysRemoved: number;
  tapDevicesRemoved: number;
  spaceFreed: number;
  jobsRemoved: number;
}

export interface AgentHealth {
  status: string;
  services: Record<string, boolean>;
  uptime: number;
}

export interface AgentMetrics {
  cpu: number;
  memory: { used: number; total: number; percent: number };
  disk: { used: number; total: number; percent: number };
}

export interface App {
  port: number;
  name: string;
  url: string;
}

export interface ExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface ServiceStatus {
  name: string;
  running: boolean;
  pid?: number;
}
