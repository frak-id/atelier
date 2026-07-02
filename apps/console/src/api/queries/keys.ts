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
} as const;
