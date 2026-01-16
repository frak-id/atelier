import {
  queryOptions,
  useMutation,
  useQueryClient,
} from "@tanstack/react-query";
import {
  api,
  type CreateProjectOptions,
  type CreateSandboxOptions,
  type UpdateProjectOptions,
} from "./client";
import {
  deleteOpenCodeSession,
  fetchOpenCodeHealth,
  fetchOpenCodeMessages,
  fetchOpenCodeSessions,
} from "./opencode";

export const queryKeys = {
  health: ["health"] as const,
  sandboxes: {
    all: ["sandboxes"] as const,
    list: (filters?: { status?: string; projectId?: string }) =>
      ["sandboxes", "list", filters] as const,
    detail: (id: string) => ["sandboxes", "detail", id] as const,
    job: (id: string) => ["sandboxes", "job", id] as const,
    health: (id: string) => ["sandboxes", id, "health"] as const,
    metrics: (id: string) => ["sandboxes", id, "metrics"] as const,
    apps: (id: string) => ["sandboxes", id, "apps"] as const,
    services: (id: string) => ["sandboxes", id, "services"] as const,
  },
  opencode: {
    health: (baseUrl: string) => ["opencode", baseUrl, "health"] as const,
    sessions: (baseUrl: string) => ["opencode", baseUrl, "sessions"] as const,
    messages: (baseUrl: string, sessionId: string) =>
      ["opencode", baseUrl, "messages", sessionId] as const,
  },
  projects: {
    all: ["projects"] as const,
    list: (filters?: { prebuildStatus?: string }) =>
      ["projects", "list", filters] as const,
    detail: (id: string) => ["projects", "detail", id] as const,
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
};

export const healthQuery = queryOptions({
  queryKey: queryKeys.health,
  queryFn: () => api.health.get(),
  refetchInterval: 30000,
});

export const sandboxListQuery = (filters?: {
  status?: string;
  projectId?: string;
}) =>
  queryOptions({
    queryKey: queryKeys.sandboxes.list(filters),
    queryFn: () => api.sandboxes.list(filters),
    refetchInterval: 5000,
  });

export const sandboxDetailQuery = (id: string) =>
  queryOptions({
    queryKey: queryKeys.sandboxes.detail(id),
    queryFn: () => api.sandboxes.get(id),
    refetchInterval: 5000,
  });

export const sandboxJobQuery = (id: string) =>
  queryOptions({
    queryKey: queryKeys.sandboxes.job(id),
    queryFn: () => api.sandboxes.getJob(id),
    refetchInterval: 2000,
  });

export const sandboxHealthQuery = (id: string) =>
  queryOptions({
    queryKey: queryKeys.sandboxes.health(id),
    queryFn: () => api.sandboxes.health(id),
    refetchInterval: 10000,
  });

export const sandboxMetricsQuery = (id: string) =>
  queryOptions({
    queryKey: queryKeys.sandboxes.metrics(id),
    queryFn: () => api.sandboxes.metrics(id),
    refetchInterval: 5000,
  });

export const sandboxAppsQuery = (id: string) =>
  queryOptions({
    queryKey: queryKeys.sandboxes.apps(id),
    queryFn: () => api.sandboxes.apps(id),
    refetchInterval: 10000,
  });

export const sandboxServicesQuery = (id: string) =>
  queryOptions({
    queryKey: queryKeys.sandboxes.services(id),
    queryFn: () => api.sandboxes.services(id),
    refetchInterval: 10000,
  });

export const projectListQuery = (filters?: { prebuildStatus?: string }) =>
  queryOptions({
    queryKey: queryKeys.projects.list(filters),
    queryFn: () => api.projects.list(filters),
  });

export const projectDetailQuery = (id: string) =>
  queryOptions({
    queryKey: queryKeys.projects.detail(id),
    queryFn: () => api.projects.get(id),
  });

export const imageListQuery = (all?: boolean) =>
  queryOptions({
    queryKey: queryKeys.images.list(all),
    queryFn: () => api.images.list(all),
  });

export const systemStatsQuery = queryOptions({
  queryKey: queryKeys.system.stats,
  queryFn: () => api.system.stats(),
  refetchInterval: 5000,
});

export const systemStorageQuery = queryOptions({
  queryKey: queryKeys.system.storage,
  queryFn: () => api.system.storage(),
  refetchInterval: 30000,
});

export const systemQueueQuery = queryOptions({
  queryKey: queryKeys.system.queue,
  queryFn: () => api.system.queue(),
  refetchInterval: 2000,
});

export function useCreateSandbox() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: CreateSandboxOptions) => api.sandboxes.create(data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.sandboxes.all });
      queryClient.invalidateQueries({ queryKey: queryKeys.system.stats });
      queryClient.invalidateQueries({ queryKey: queryKeys.system.queue });
    },
  });
}

export function useDeleteSandbox() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.sandboxes.delete(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.sandboxes.all });
      queryClient.invalidateQueries({ queryKey: queryKeys.system.stats });
    },
  });
}

export function useStopSandbox() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.sandboxes.stop(id),
    onSuccess: (_data, id) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.sandboxes.all });
      queryClient.invalidateQueries({
        queryKey: queryKeys.sandboxes.detail(id),
      });
    },
  });
}

export function useStartSandbox() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.sandboxes.start(id),
    onSuccess: (_data, id) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.sandboxes.all });
      queryClient.invalidateQueries({
        queryKey: queryKeys.sandboxes.detail(id),
      });
    },
  });
}

export function useExecCommand(sandboxId: string) {
  return useMutation({
    mutationFn: (data: { command: string; timeout?: number }) =>
      api.sandboxes.exec(sandboxId, data),
  });
}

export function useCreateProject() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: CreateProjectOptions) => api.projects.create(data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.projects.all });
    },
  });
}

export function useUpdateProject() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, data }: { id: string; data: UpdateProjectOptions }) =>
      api.projects.update(id, data),
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.projects.all });
      queryClient.invalidateQueries({
        queryKey: queryKeys.projects.detail(variables.id),
      });
    },
  });
}

export function useDeleteProject() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.projects.delete(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.projects.all });
    },
  });
}

export function useTriggerPrebuild() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.projects.triggerPrebuild(id),
    onSuccess: (_data, id) => {
      queryClient.invalidateQueries({
        queryKey: queryKeys.projects.detail(id),
      });
    },
  });
}

export function useSystemCleanup() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => api.system.cleanup(),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.system.stats });
      queryClient.invalidateQueries({ queryKey: queryKeys.system.storage });
    },
  });
}

export const opencodeHealthQuery = (baseUrl: string) =>
  queryOptions({
    queryKey: queryKeys.opencode.health(baseUrl),
    queryFn: () => fetchOpenCodeHealth(baseUrl),
    refetchInterval: 30000,
    enabled: !!baseUrl,
  });

export const opencodeSessionsQuery = (baseUrl: string) =>
  queryOptions({
    queryKey: queryKeys.opencode.sessions(baseUrl),
    queryFn: () => fetchOpenCodeSessions(baseUrl),
    refetchInterval: 10000,
    enabled: !!baseUrl,
  });

export const opencodeMessagesQuery = (baseUrl: string, sessionId: string) =>
  queryOptions({
    queryKey: queryKeys.opencode.messages(baseUrl, sessionId),
    queryFn: () => fetchOpenCodeMessages(baseUrl, sessionId),
    enabled: !!baseUrl && !!sessionId,
  });

export function useDeleteOpenCodeSession(baseUrl: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (sessionId: string) =>
      deleteOpenCodeSession(baseUrl, sessionId),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: queryKeys.opencode.sessions(baseUrl),
      });
    },
  });
}
