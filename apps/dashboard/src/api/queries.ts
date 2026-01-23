import type { TaskEffort } from "@frak-sandbox/shared/constants";
import { queryOptions, useMutation, useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { api, type Workspace } from "./client";
import { deleteOpenCodeSession, fetchOpenCodeSessions } from "./opencode";

function unwrap<T>(result: { data: T; error: unknown }): T {
  if (result.error) {
    throw result.error;
  }
  return result.data;
}

const queryKeys = {
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
};

export const healthQuery = queryOptions({
  queryKey: queryKeys.health,
  queryFn: async () => unwrap(await api.health.get()),
  refetchInterval: 30000,
});

export const sandboxListQuery = (filters?: {
  status?: string;
  workspaceId?: string;
}) =>
  queryOptions({
    queryKey: queryKeys.sandboxes.list(filters),
    queryFn: async () =>
      unwrap(
        await api.api.sandboxes.get({
          query: filters as Record<string, string>,
        }),
      ),
    refetchInterval: 5000,
  });

export const sandboxDetailQuery = (id: string) =>
  queryOptions({
    queryKey: queryKeys.sandboxes.detail(id),
    queryFn: async () => unwrap(await api.api.sandboxes({ id }).get()),
    refetchInterval: 5000,
  });

export const sandboxMetricsQuery = (id: string) =>
  queryOptions({
    queryKey: queryKeys.sandboxes.metrics(id),
    queryFn: async () => unwrap(await api.api.sandboxes({ id }).metrics.get()),
    refetchInterval: 5000,
  });

export const sandboxServicesQuery = (id: string) =>
  queryOptions({
    queryKey: queryKeys.sandboxes.services(id),
    queryFn: async () => unwrap(await api.api.sandboxes({ id }).services.get()),
    refetchInterval: 10000,
  });

export const sandboxGitStatusQuery = (id: string) =>
  queryOptions({
    queryKey: queryKeys.sandboxes.gitStatus(id),
    queryFn: async () =>
      unwrap(await api.api.sandboxes({ id }).git.status.get()),
    refetchInterval: 10000,
  });

export const workspaceListQuery = () =>
  queryOptions({
    queryKey: queryKeys.workspaces.list(),
    queryFn: async () => unwrap(await api.api.workspaces.get()),
  });

export function useWorkspaceMap() {
  const { data: workspaces } = useQuery(workspaceListQuery());

  return useMemo(() => {
    const map = new Map<string, string>();
    if (workspaces) {
      for (const w of workspaces) {
        map.set(w.id, w.name);
      }
    }
    return map;
  }, [workspaces]);
}

export function useWorkspaceDataMap() {
  const { data: workspaces } = useQuery(workspaceListQuery());

  return useMemo(() => {
    const map = new Map<string, Workspace>();
    if (workspaces) {
      for (const w of workspaces) {
        map.set(w.id, w);
      }
    }
    return map;
  }, [workspaces]);
}

export const workspaceDetailQuery = (id: string) =>
  queryOptions({
    queryKey: queryKeys.workspaces.detail(id),
    queryFn: async () => unwrap(await api.api.workspaces({ id }).get()),
  });

export const imageListQuery = (all?: boolean) =>
  queryOptions({
    queryKey: queryKeys.images.list(all),
    queryFn: async () =>
      unwrap(await api.api.images.get({ query: { all: all ?? undefined } })),
  });

export const systemStatsQuery = queryOptions({
  queryKey: queryKeys.system.stats,
  queryFn: async () => unwrap(await api.api.system.stats.get()),
  refetchInterval: 5000,
});

export const systemStorageQuery = queryOptions({
  queryKey: queryKeys.system.storage,
  queryFn: async () => unwrap(await api.api.system.storage.get()),
  refetchInterval: 30000,
});

export const systemQueueQuery = queryOptions({
  queryKey: queryKeys.system.queue,
  queryFn: async () => unwrap(await api.api.system.queue.get()),
  refetchInterval: 2000,
});

export function useCreateSandbox() {
  return useMutation({
    mutationFn: async (data: {
      workspaceId?: string;
      baseImage?: string;
      vcpus?: number;
      memoryMb?: number;
    }) => unwrap(await api.api.sandboxes.post(data)),
    onSuccess: (_data, _variables, _context, { client: queryClient }) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.sandboxes.all });
      queryClient.invalidateQueries({ queryKey: queryKeys.system.stats });
      queryClient.invalidateQueries({ queryKey: queryKeys.system.queue });
    },
  });
}

export function useDeleteSandbox() {
  return useMutation({
    mutationFn: async (id: string) =>
      unwrap(await api.api.sandboxes({ id }).delete()),
    onSuccess: (_data, _variables, _context, { client: queryClient }) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.sandboxes.all });
      queryClient.invalidateQueries({ queryKey: queryKeys.system.stats });
    },
  });
}

export function useStopSandbox() {
  return useMutation({
    mutationFn: async (id: string) =>
      unwrap(await api.api.sandboxes({ id }).stop.post()),
    onSuccess: (_data, id, _context, { client: queryClient }) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.sandboxes.all });
      queryClient.invalidateQueries({
        queryKey: queryKeys.sandboxes.detail(id),
      });
    },
  });
}

export function useStartSandbox() {
  return useMutation({
    mutationFn: async (id: string) =>
      unwrap(await api.api.sandboxes({ id }).start.post()),
    onSuccess: (_data, id, _context, { client: queryClient }) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.sandboxes.all });
      queryClient.invalidateQueries({
        queryKey: queryKeys.sandboxes.detail(id),
      });
    },
  });
}

export function useRestartSandbox() {
  return useMutation({
    mutationFn: async (id: string) =>
      unwrap(await api.api.sandboxes({ id }).restart.post()),
    onSuccess: (_data, id, _context, { client: queryClient }) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.sandboxes.all });
      queryClient.invalidateQueries({
        queryKey: queryKeys.sandboxes.detail(id),
      });
    },
  });
}

export function useExecCommand(sandboxId: string) {
  return useMutation({
    mutationFn: async (data: { command: string; timeout?: number }) =>
      unwrap(await api.api.sandboxes({ id: sandboxId }).exec.post(data)),
  });
}

export function useResizeStorage(sandboxId: string) {
  return useMutation({
    mutationFn: async (sizeGb: number) =>
      unwrap(
        await api.api.sandboxes({ id: sandboxId }).storage.resize.post({
          sizeGb,
        }),
      ),
    onSuccess: (_data, _variables, _context, { client: queryClient }) => {
      queryClient.invalidateQueries({
        queryKey: queryKeys.sandboxes.metrics(sandboxId),
      });
    },
  });
}

export function useCreateWorkspace() {
  return useMutation({
    mutationFn: async (data: {
      name: string;
      config?: Record<string, unknown>;
    }) => unwrap(await api.api.workspaces.post(data)),
    onSuccess: (_data, _variables, _context, { client: queryClient }) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.workspaces.all });
    },
  });
}

export function useUpdateWorkspace() {
  return useMutation({
    mutationFn: async ({
      id,
      data,
    }: {
      id: string;
      data: { name?: string; config?: Record<string, unknown> };
    }) => unwrap(await api.api.workspaces({ id }).put(data)),
    onSuccess: (_data, variables, _context, { client: queryClient }) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.workspaces.all });
      queryClient.invalidateQueries({
        queryKey: queryKeys.workspaces.detail(variables.id),
      });
    },
  });
}

export function useDeleteWorkspace() {
  return useMutation({
    mutationFn: async (id: string) =>
      unwrap(await api.api.workspaces({ id }).delete()),
    onSuccess: (_data, _variables, _context, { client: queryClient }) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.workspaces.all });
    },
  });
}

export function useTriggerPrebuild() {
  return useMutation({
    mutationFn: async (id: string) =>
      unwrap(await api.api.workspaces({ id }).prebuild.post()),
    onSuccess: (_data, id, _context, { client: queryClient }) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.workspaces.all });
      queryClient.invalidateQueries({
        queryKey: queryKeys.workspaces.detail(id),
      });
    },
  });
}

export function useDeletePrebuild() {
  return useMutation({
    mutationFn: async (id: string) =>
      unwrap(await api.api.workspaces({ id }).prebuild.delete()),
    onSuccess: (_data, id, _context, { client: queryClient }) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.workspaces.all });
      queryClient.invalidateQueries({
        queryKey: queryKeys.workspaces.detail(id),
      });
    },
  });
}

export function useSaveAsPrebuild() {
  return useMutation({
    mutationFn: async (sandboxId: string) =>
      unwrap(await api.api.sandboxes({ id: sandboxId }).promote.post()),
    onSuccess: (_data, _variables, _context, { client: queryClient }) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.workspaces.all });
      queryClient.invalidateQueries({ queryKey: queryKeys.sandboxes.all });
    },
  });
}

export function useSystemCleanup() {
  return useMutation({
    mutationFn: async () => unwrap(await api.api.system.cleanup.post()),
    onSuccess: (_data, _variables, _context, { client: queryClient }) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.system.stats });
      queryClient.invalidateQueries({ queryKey: queryKeys.system.storage });
    },
  });
}

export const opencodeSessionsQuery = (baseUrl: string) =>
  queryOptions({
    queryKey: queryKeys.opencode.sessions(baseUrl),
    queryFn: () => fetchOpenCodeSessions(baseUrl),
    refetchInterval: 10000,
    enabled: !!baseUrl,
  });

export function useDeleteOpenCodeSession(baseUrl: string) {
  return useMutation({
    mutationFn: (sessionId: string) =>
      deleteOpenCodeSession(baseUrl, sessionId),
    onSuccess: (_data, _variables, _context, { client: queryClient }) => {
      queryClient.invalidateQueries({
        queryKey: queryKeys.opencode.sessions(baseUrl),
      });
    },
  });
}

export const configFilesListQuery = (params?: {
  scope?: string;
  workspaceId?: string;
}) =>
  queryOptions({
    queryKey: queryKeys.configFiles.list(params),
    queryFn: async () =>
      unwrap(
        await api.api["config-files"].get({
          query: params as Record<string, string>,
        }),
      ),
  });

export function useCreateConfigFile() {
  return useMutation({
    mutationFn: async (data: {
      path: string;
      content: string;
      contentType: "json" | "text" | "binary";
      scope: "global" | "workspace";
      workspaceId?: string;
    }) => unwrap(await api.api["config-files"].post(data)),
    onSuccess: (_data, _variables, _context, { client: queryClient }) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.configFiles.all });
    },
  });
}

export function useUpdateConfigFile() {
  return useMutation({
    mutationFn: async ({
      id,
      data,
    }: {
      id: string;
      data: { content?: string; contentType?: "json" | "text" | "binary" };
    }) => unwrap(await api.api["config-files"]({ id }).put(data)),
    onSuccess: (_data, _variables, _context, { client: queryClient }) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.configFiles.all });
    },
  });
}

export function useDeleteConfigFile() {
  return useMutation({
    mutationFn: async (id: string) =>
      unwrap(await api.api["config-files"]({ id }).delete()),
    onSuccess: (_data, _variables, _context, { client: queryClient }) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.configFiles.all });
    },
  });
}

export function useSyncConfigsToNfs() {
  return useMutation({
    mutationFn: async () =>
      unwrap(await api.api["config-files"]["sync-to-nfs"].post()),
  });
}

export const sharedAuthListQuery = queryOptions({
  queryKey: ["sharedAuth", "list"] as const,
  queryFn: async () => unwrap(await api.api["shared-auth"].get()),
});

export function useUpdateSharedAuth() {
  return useMutation({
    mutationFn: async ({
      provider,
      content,
    }: {
      provider: string;
      content: string;
    }) => unwrap(await api.api["shared-auth"]({ provider }).put({ content })),
    onSuccess: (_data, _variables, _context, { client: queryClient }) => {
      queryClient.invalidateQueries({ queryKey: ["sharedAuth"] });
    },
  });
}

export const sandboxDiscoverConfigsQuery = (id: string) =>
  queryOptions({
    queryKey: queryKeys.sandboxes.discoverConfigs(id),
    queryFn: async () =>
      unwrap(await api.api.sandboxes({ id }).config.discover.get()),
    enabled: !!id,
  });

export function useExtractConfig(sandboxId: string) {
  return useMutation({
    mutationFn: async (path: string) =>
      unwrap(
        await api.api.sandboxes({ id: sandboxId }).config.extract.post({
          path,
        }),
      ),
    onSuccess: (_data, _variables, _context, { client: queryClient }) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.configFiles.all });
    },
  });
}

export const githubStatusQuery = queryOptions({
  queryKey: queryKeys.github.status,
  queryFn: async () => unwrap(await api.auth.github.status.get()),
  staleTime: 60000,
});

export const githubReposQuery = (params?: {
  page?: number;
  perPage?: number;
}) =>
  queryOptions({
    queryKey: queryKeys.github.repos(params),
    queryFn: async () =>
      unwrap(
        await api.api.github.repos.get({
          query: params
            ? {
                page: params.page?.toString(),
                perPage: params.perPage?.toString(),
              }
            : {},
        }),
      ),
  });

export const githubBranchesQuery = (owner: string, repo: string) =>
  queryOptions({
    queryKey: ["github", "branches", owner, repo] as const,
    queryFn: async () =>
      unwrap(
        await api.api.github.branches.get({
          query: { owner, repo },
        }),
      ),
    enabled: !!owner && !!repo,
    staleTime: 60000,
  });

export function useGitHubLogout() {
  return useMutation({
    mutationFn: async () => unwrap(await api.auth.github.logout.post()),
    onSuccess: (_data, _variables, _context, { client: queryClient }) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.github.status });
    },
  });
}

export function useGitHubReauthorize() {
  return useMutation({
    mutationFn: async () => {
      const API_BASE = import.meta.env.PROD
        ? "https://sandbox-api.nivelais.com"
        : "http://localhost:4000";
      window.location.href = `${API_BASE}/auth/github/reauthorize`;
    },
  });
}

export const sharedStorageQuery = queryOptions({
  queryKey: queryKeys.sharedStorage.all,
  queryFn: async () => unwrap(await api.api.storage.get()),
  refetchInterval: 30000,
});

export function useInstallBinary() {
  return useMutation({
    mutationFn: async (id: string) =>
      unwrap(await api.api.storage.binaries({ id }).install.post()),
    onSuccess: (_data, _variables, _context, { client: queryClient }) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.sharedStorage.all });
    },
  });
}

export function useRemoveBinary() {
  return useMutation({
    mutationFn: async (id: string) =>
      unwrap(await api.api.storage.binaries({ id }).delete()),
    onSuccess: (_data, _variables, _context, { client: queryClient }) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.sharedStorage.all });
    },
  });
}

export function usePurgeCache() {
  return useMutation({
    mutationFn: async (folder: string) =>
      unwrap(await api.api.storage.cache({ folder }).delete()),
    onSuccess: (_data, _variables, _context, { client: queryClient }) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.sharedStorage.all });
    },
  });
}

export const sshKeysListQuery = queryOptions({
  queryKey: queryKeys.sshKeys.list(),
  queryFn: async () => unwrap(await api.api["ssh-keys"].get()),
});

export const sshKeysHasKeysQuery = queryOptions({
  queryKey: queryKeys.sshKeys.hasKeys(),
  queryFn: async () => unwrap(await api.api["ssh-keys"]["has-keys"].get()),
  staleTime: 60000,
});

export function useCreateSshKey() {
  return useMutation({
    mutationFn: async (data: {
      publicKey: string;
      name: string;
      type: "generated" | "uploaded";
      expiresAt?: string;
    }) => unwrap(await api.api["ssh-keys"].post(data)),
    onSuccess: (_data, _variables, _context, { client: queryClient }) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.sshKeys.all });
    },
  });
}

export function useDeleteSshKey() {
  return useMutation({
    mutationFn: async (id: string) =>
      unwrap(await api.api["ssh-keys"]({ id }).delete()),
    onSuccess: (_data, _variables, _context, { client: queryClient }) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.sshKeys.all });
    },
  });
}

export const taskListQuery = (workspaceId?: string) =>
  queryOptions({
    queryKey: queryKeys.tasks.list(workspaceId),
    queryFn: async () =>
      unwrap(
        await api.api.tasks.get({
          query: workspaceId ? { workspaceId } : {},
        }),
      ),
    refetchInterval: 5000,
  });

export const taskDetailQuery = (id: string) =>
  queryOptions({
    queryKey: queryKeys.tasks.detail(id),
    queryFn: async () => unwrap(await api.api.tasks({ id }).get()),
    refetchInterval: 5000,
  });

export function useCreateTask() {
  return useMutation({
    mutationFn: async (data: {
      workspaceId: string;
      title: string;
      description: string;
      context?: string;
      effort?: TaskEffort;
      baseBranch?: string;
      targetRepoIndices?: number[];
    }) => unwrap(await api.api.tasks.post(data)),
    onSuccess: (_data, _variables, _context, { client: queryClient }) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.tasks.all });
    },
  });
}

export function useUpdateTask() {
  return useMutation({
    mutationFn: async ({
      id,
      data,
    }: {
      id: string;
      data: {
        title?: string;
        description?: string;
        context?: string;
        effort?: TaskEffort;
      };
    }) => unwrap(await api.api.tasks({ id }).put(data)),
    onSuccess: (_data, variables, _context, { client: queryClient }) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.tasks.all });
      queryClient.invalidateQueries({
        queryKey: queryKeys.tasks.detail(variables.id),
      });
    },
  });
}

export function useStartTask() {
  return useMutation({
    mutationFn: async (id: string) =>
      unwrap(await api.api.tasks({ id }).start.post()),
    onSuccess: (_data, _variables, _context, { client: queryClient }) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.tasks.all });
      queryClient.invalidateQueries({ queryKey: queryKeys.sandboxes.all });
    },
  });
}

export function useMoveTaskToReview() {
  return useMutation({
    mutationFn: async (id: string) =>
      unwrap(await api.api.tasks({ id }).review.post()),
    onSuccess: (_data, _variables, _context, { client: queryClient }) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.tasks.all });
    },
  });
}

export function useCompleteTask() {
  return useMutation({
    mutationFn: async (id: string) =>
      unwrap(await api.api.tasks({ id }).complete.post()),
    onSuccess: (_data, _variables, _context, { client: queryClient }) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.tasks.all });
    },
  });
}

export function useResetTask() {
  return useMutation({
    mutationFn: async (id: string) =>
      unwrap(await api.api.tasks({ id }).reset.post()),
    onSuccess: (_data, _variables, _context, { client: queryClient }) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.tasks.all });
    },
  });
}

export function useReorderTask() {
  return useMutation({
    mutationFn: async ({ id, order }: { id: string; order: number }) =>
      unwrap(await api.api.tasks({ id }).order.put({ order })),
    onSuccess: (_data, _variables, _context, { client: queryClient }) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.tasks.all });
    },
  });
}

export function useDeleteTask() {
  return useMutation({
    mutationFn: async ({
      id,
      keepSandbox,
    }: {
      id: string;
      keepSandbox: boolean;
    }) =>
      unwrap(
        await api.api.tasks({ id }).delete({
          query: { keepSandbox: keepSandbox ? "true" : undefined },
        }),
      ),
    onSuccess: (_data, _variables, _context, { client: queryClient }) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.tasks.all });
      queryClient.invalidateQueries({ queryKey: queryKeys.sandboxes.all });
    },
  });
}
