export function unwrap<T>(result: { data: T; error: unknown }): T {
  if (result.error) {
    throw result.error;
  }
  return result.data;
}

/** Extract a human-readable message from an Eden treaty error (`{ status, value: { message } }`) or plain Error. */
export function apiErrorMessage(error: unknown, fallback: string): string {
  if (error && typeof error === "object") {
    const value = (error as { value?: unknown }).value;
    if (value && typeof value === "object") {
      const message = (value as { message?: unknown }).message;
      if (typeof message === "string" && message) return message;
    }
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string" && message) return message;
  }
  return fallback;
}

export const queryKeys = {
  health: ["health"] as const,
  sandboxes: {
    all: ["sandboxes"] as const,
    list: (filters?: { status?: string; workspaceId?: string }) =>
      ["sandboxes", "list", filters] as const,
    detail: (id: string) => ["sandboxes", "detail", id] as const,
    job: (id: string) => ["sandboxes", "job", id] as const,
    metrics: (id: string) => ["sandboxes", id, "metrics"] as const,
    apps: (id: string) => ["sandboxes", id, "apps"] as const,
    services: (id: string) => ["sandboxes", id, "services"] as const,
    allServices: ["sandboxes", "allServices"] as const,
    tools: (id: string) => ["sandboxes", id, "tools"] as const,
    serviceLogs: (id: string, name: string, offset: number) =>
      ["sandboxes", id, "serviceLogs", name, offset] as const,
    gitStatus: (id: string) => ["sandboxes", id, "gitStatus"] as const,
    gitDiff: (id: string) => ["sandboxes", id, "gitDiff"] as const,
    terminalSessions: (id: string) =>
      ["sandboxes", id, "terminalSessions"] as const,
  },
  agent: {
    sessions: (sandboxId: string) => ["agent", sandboxId, "sessions"] as const,
    permissions: (sandboxId: string) =>
      ["agent", sandboxId, "permissions"] as const,
    questions: (sandboxId: string) =>
      ["agent", sandboxId, "questions"] as const,
    sessionStatuses: (sandboxId: string) =>
      ["agent", sandboxId, "sessionStatuses"] as const,
    todos: (sandboxId: string, sessionId: string) =>
      ["agent", sandboxId, "todos", sessionId] as const,
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
    builds: ["images", "builds"] as const,
    buildStatus: (id: string) => ["images", id, "buildStatus"] as const,
    rebuildAll: ["images", "rebuildAll"] as const,
  },
  system: {
    stats: ["system", "stats"] as const,
    services: ["system", "services"] as const,
    sharedBinaries: ["system", "shared-binaries"] as const,
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
  apiKeys: {
    all: ["apiKeys"] as const,
    list: () => ["apiKeys", "list"] as const,
  },
  cliproxy: {
    all: ["cliproxy"] as const,
    status: ["cliproxy", "status"] as const,
    export: ["cliproxy", "export"] as const,
    userApiKey: ["cliproxy", "userApiKey"] as const,
  },
  organizations: {
    all: ["organizations"] as const,
    list: () => ["organizations", "list"] as const,
    detail: (slug: string) => ["organizations", "detail", slug] as const,
    members: (slug: string) => ["organizations", slug, "members"] as const,
  },
  users: {
    all: ["users"] as const,
    list: () => ["users", "list"] as const,
  },
};
