import { queryOptions, useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { api, type Workspace } from "./client";
import { fetchOpenCodeSessions } from "./opencode";
import { queryKeys } from "./query-keys";

function unwrap<T>(result: { data: T; error: unknown }): T {
  if (result.error) {
    throw result.error;
  }
  return result.data;
}

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

export const opencodeSessionsQuery = (baseUrl: string) =>
  queryOptions({
    queryKey: queryKeys.opencode.sessions(baseUrl),
    queryFn: () => fetchOpenCodeSessions(baseUrl),
    staleTime: 30000,
    enabled: !!baseUrl,
  });

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

export const sharedAuthListQuery = queryOptions({
  queryKey: ["sharedAuth", "list"] as const,
  queryFn: async () => unwrap(await api.api["shared-auth"].get()),
});

export const sandboxDiscoverConfigsQuery = (id: string) =>
  queryOptions({
    queryKey: queryKeys.sandboxes.discoverConfigs(id),
    queryFn: async () =>
      unwrap(await api.api.sandboxes({ id }).config.discover.get()),
    enabled: !!id,
  });

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
    queryKey: queryKeys.github.branches(owner, repo),
    queryFn: async () =>
      unwrap(
        await api.api.github.branches.get({
          query: { owner, repo },
        }),
      ),
    enabled: !!owner && !!repo,
    staleTime: 60000,
  });

export const sharedStorageQuery = queryOptions({
  queryKey: queryKeys.sharedStorage.all,
  queryFn: async () => unwrap(await api.api.storage.get()),
  refetchInterval: 30000,
});

export const sshKeysListQuery = queryOptions({
  queryKey: queryKeys.sshKeys.list(),
  queryFn: async () => unwrap(await api.api["ssh-keys"].get()),
});

export const sshKeysHasKeysQuery = queryOptions({
  queryKey: queryKeys.sshKeys.hasKeys(),
  queryFn: async () => unwrap(await api.api["ssh-keys"]["has-keys"].get()),
  staleTime: 60000,
});

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

export {
  useCompleteTask,
  useCreateConfigFile,
  useCreateSandbox,
  useCreateSshKey,
  useCreateTask,
  useCreateWorkspace,
  useDeleteConfigFile,
  useDeleteOpenCodeSession,
  useDeletePrebuild,
  useDeleteSandbox,
  useDeleteSshKey,
  useDeleteTask,
  useDeleteWorkspace,
  useExecCommand,
  useExtractConfig,
  useGitHubLogout,
  useGitHubReauthorize,
  useInstallBinary,
  useMoveTaskToReview,
  usePurgeCache,
  useRemoveBinary,
  useReorderTask,
  useResetTask,
  useResizeStorage,
  useRestartSandbox,
  useSaveAsPrebuild,
  useStartSandbox,
  useStartTask,
  useStopSandbox,
  useSyncConfigsToNfs,
  useSystemCleanup,
  useTriggerPrebuild,
  useUpdateConfigFile,
  useUpdateSharedAuth,
  useUpdateTask,
  useUpdateWorkspace,
} from "./mutations";
