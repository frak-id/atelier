export function unwrap<T>(result: { data: T; error: unknown }): T {
  if (result.error) {
    throw result.error;
  }
  return result.data;
}

export const queryKeys = {
  health: ["health"] as const,
  sharedStorage: {
    all: ["sharedStorage"] as const,
    binaries: ["sharedStorage", "binaries"] as const,
  },
  registry: {
    status: ["registry", "status"] as const,
  },
  tasks: {
    all: ["tasks"] as const,
    list: (workspaceId?: string) => ["tasks", "list", workspaceId] as const,
    detail: (id: string) => ["tasks", "detail", id] as const,
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
    devCommands: (id: string) => ["sandboxes", id, "devCommands"] as const,
    devCommandLogs: (id: string, name: string, offset: number) =>
      ["sandboxes", id, "devCommandLogs", name, offset] as const,
    gitStatus: (id: string) => ["sandboxes", id, "gitStatus"] as const,
  },
  opencode: {
    health: (baseUrl: string) => ["opencode", baseUrl, "health"] as const,
    sessions: (baseUrl: string) => ["opencode", baseUrl, "sessions"] as const,
    messages: (baseUrl: string, sessionId: string) =>
      ["opencode", baseUrl, "messages", sessionId] as const,
    permissions: (baseUrl: string) =>
      ["opencode", baseUrl, "permissions"] as const,
    questions: (baseUrl: string) => ["opencode", baseUrl, "questions"] as const,
    sessionStatuses: (baseUrl: string) =>
      ["opencode", baseUrl, "sessionStatuses"] as const,
    todos: (baseUrl: string, sessionId: string) =>
      ["opencode", baseUrl, "todos", sessionId] as const,
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
  },
  sshKeys: {
    all: ["sshKeys"] as const,
    list: () => ["sshKeys", "list"] as const,
    hasKeys: () => ["sshKeys", "hasKeys"] as const,
  },
  sessionTemplates: {
    all: ["sessionTemplates"] as const,
    global: ["sessionTemplates", "global"] as const,
    workspace: (workspaceId: string) =>
      ["sessionTemplates", "workspace", workspaceId] as const,
    workspaceOverride: (workspaceId: string) =>
      ["sessionTemplates", "workspaceOverride", workspaceId] as const,
    opencodeConfig: (workspaceId: string) =>
      ["sessionTemplates", "opencodeConfig", workspaceId] as const,
    opencodeConfigGlobal: [
      "sessionTemplates",
      "opencodeConfig",
      "global",
    ] as const,
  },
};
