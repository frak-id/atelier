/**
 * Central query-key registry. Each domain query module references these so
 * mutations can invalidate precisely.
 */
export const queryKeys = {
  auth: {
    me: ["auth", "me"] as const,
  },
  sandboxes: {
    all: ["sandboxes"] as const,
    list: () => [...queryKeys.sandboxes.all, "list"] as const,
    detail: (id: string) => [...queryKeys.sandboxes.all, "detail", id] as const,
    processLogs: (id: string, name: string) =>
      [...queryKeys.sandboxes.all, "detail", id, "logs", name] as const,
  },
  savedSpecs: {
    all: ["saved-specs"] as const,
    list: () => [...queryKeys.savedSpecs.all, "list"] as const,
  },
  sessions: {
    all: (sandboxId: string) => ["sessions", sandboxId] as const,
    list: (sandboxId: string) =>
      [...queryKeys.sessions.all(sandboxId), "list"] as const,
    statuses: (sandboxId: string) =>
      [...queryKeys.sessions.all(sandboxId), "statuses"] as const,
    todos: (sandboxId: string, sessionId: string) =>
      [...queryKeys.sessions.all(sandboxId), "todos", sessionId] as const,
    permissions: (sandboxId: string) =>
      [...queryKeys.sessions.all(sandboxId), "permissions"] as const,
    questions: (sandboxId: string) =>
      [...queryKeys.sessions.all(sandboxId), "questions"] as const,
  },
  terminal: {
    all: (sandboxId: string) => ["terminal", sandboxId] as const,
    list: (sandboxId: string) =>
      [...queryKeys.terminal.all(sandboxId), "list"] as const,
  },
  apiKeys: {
    all: ["api-keys"] as const,
    list: () => [...queryKeys.apiKeys.all, "list"] as const,
  },
  sshKeys: {
    all: ["ssh-keys"] as const,
    list: () => [...queryKeys.sshKeys.all, "list"] as const,
  },
  secrets: {
    all: ["secrets"] as const,
    list: (orgId?: string) =>
      [...queryKeys.secrets.all, "list", orgId ?? "none"] as const,
  },
  organizations: {
    all: ["organizations"] as const,
    list: () => [...queryKeys.organizations.all, "list"] as const,
    members: (orgId: string) =>
      [...queryKeys.organizations.all, "members", orgId] as const,
  },
  orgPolicy: {
    all: ["org-policy"] as const,
    detail: (orgId: string) => [...queryKeys.orgPolicy.all, orgId] as const,
  },
  toolsets: {
    all: ["toolsets"] as const,
    list: () => [...queryKeys.toolsets.all, "list"] as const,
  },
  toolboxes: {
    all: ["toolboxes"] as const,
    list: (owner?: string) =>
      [...queryKeys.toolboxes.all, "list", owner ?? "user"] as const,
  },
} as const;
