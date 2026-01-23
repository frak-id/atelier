export const queryKeys = {
  health: ["health"] as const,

  sharedStorage: {
    all: ["sharedStorage"] as const,
    binaries: ["sharedStorage", "binaries"] as const,
    cache: ["sharedStorage", "cache"] as const,
  },

  tasks: {
    all: ["tasks"] as const,
    list: (workspaceId?: string) => ["tasks", "list", workspaceId] as const,
    detail: (id: string) => ["tasks", "detail", id] as const,
    attention: () => ["tasks", "attention"] as const,
  },

  sandboxes: {
    all: ["sandboxes"] as const,
    list: (filters?: { status?: string; workspaceId?: string }) =>
      ["sandboxes", "list", filters] as const,
    detail: (id: string) => ["sandboxes", "detail", id] as const,
    job: (id: string) => ["sandboxes", "job", id] as const,
    health: (id: string) => ["sandboxes", id, "health"] as const,
    metrics: (id: string) => ["sandboxes", id, "metrics"] as const,
    apps: (id: string) => ["sandboxes", id, "apps"] as const,
    services: (id: string) => ["sandboxes", id, "services"] as const,
    discoverConfigs: (id: string) =>
      ["sandboxes", id, "discoverConfigs"] as const,
    gitStatus: (id: string) => ["sandboxes", id, "gitStatus"] as const,
  },

  opencode: {
    health: (baseUrl: string) => ["opencode", baseUrl, "health"] as const,
    sessions: (baseUrl: string) => ["opencode", baseUrl, "sessions"] as const,
    messages: (baseUrl: string, sessionId: string) =>
      ["opencode", baseUrl, "messages", sessionId] as const,
    status: (baseUrl: string) => ["opencode", baseUrl, "status"] as const,
  },

  workspaces: {
    all: ["workspaces"] as const,
    list: () => ["workspaces", "list"] as const,
    detail: (id: string) => ["workspaces", "detail", id] as const,
  },

  images: {
    all: ["images"] as const,
    list: (all?: boolean) => ["images", "list", { all }] as const,
    detail: (id: string) => ["images", "detail", id] as const,
  },

  system: {
    stats: ["system", "stats"] as const,
    storage: ["system", "storage"] as const,
    queue: ["system", "queue"] as const,
  },

  configFiles: {
    all: ["configFiles"] as const,
    list: (params?: { scope?: string; workspaceId?: string }) =>
      ["configFiles", "list", params] as const,
    detail: (id: string) => ["configFiles", "detail", id] as const,
    merged: (workspaceId?: string) =>
      ["configFiles", "merged", workspaceId] as const,
  },

  github: {
    status: ["github", "status"] as const,
    repos: (params?: { page?: number; perPage?: number }) =>
      ["github", "repos", params] as const,
    branches: (owner: string, repo: string) =>
      ["github", "branches", owner, repo] as const,
  },

  sshKeys: {
    all: ["sshKeys"] as const,
    list: () => ["sshKeys", "list"] as const,
    hasKeys: () => ["sshKeys", "hasKeys"] as const,
  },
} as const;
