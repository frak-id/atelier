import { queryOptions, useMutation } from "@tanstack/react-query";
import { API_HOST, api } from "../client";
import { queryKeys, unwrap } from "./keys";

// --- Health ---

export const healthQuery = queryOptions({
  queryKey: queryKeys.health,
  queryFn: async () => unwrap(await api.health.get()),
  refetchInterval: 30000,
  refetchIntervalInBackground: false,
});

// --- System ---

export const systemStatsQuery = queryOptions({
  queryKey: queryKeys.system.stats,
  queryFn: async () => unwrap(await api.api.system.stats.get()),
  refetchInterval: 5000,
  refetchIntervalInBackground: false,
});

export const systemStorageQuery = queryOptions({
  queryKey: queryKeys.system.storage,
  queryFn: async () => unwrap(await api.api.system.storage.get()),
  refetchInterval: 30000,
  refetchIntervalInBackground: false,
});

export const systemQueueQuery = queryOptions({
  queryKey: queryKeys.system.queue,
  queryFn: async () => unwrap(await api.api.system.queue.get()),
  refetchInterval: 2000,
  refetchIntervalInBackground: false,
});

export function useSystemCleanup() {
  return useMutation({
    mutationKey: ["system", "cleanup"],
    mutationFn: async () => unwrap(await api.api.system.cleanup.post()),
    onSuccess: (_data, _variables, _context, { client: queryClient }) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.system.stats });
      queryClient.invalidateQueries({ queryKey: queryKeys.system.storage });
    },
  });
}

// --- Session Templates ---

export type SessionTemplateInput = {
  id: string;
  name: string;
  category: "primary" | "secondary";
  description?: string;
  promptTemplate?: string;
  variants: Array<{
    name: string;
    model: { providerID: string; modelID: string };
    variant?: string;
    agent?: string;
  }>;
  defaultVariantIndex?: number;
};

export const globalSessionTemplatesQuery = queryOptions({
  queryKey: queryKeys.sessionTemplates.global,
  queryFn: async () => unwrap(await api.api["session-templates"].global.get()),
});

export const workspaceSessionTemplatesQuery = (workspaceId: string) =>
  queryOptions({
    queryKey: queryKeys.sessionTemplates.workspace(workspaceId),
    queryFn: async () =>
      unwrap(
        await api.api["session-templates"].workspace({ workspaceId }).get(),
      ),
    enabled: !!workspaceId,
  });

export function useUpdateGlobalSessionTemplates() {
  return useMutation({
    mutationKey: ["sessionTemplates", "updateGlobal"],
    mutationFn: async (templates: SessionTemplateInput[]) =>
      unwrap(await api.api["session-templates"].global.put({ templates })),
    onSuccess: (_data, _variables, _context, { client: queryClient }) => {
      queryClient.invalidateQueries({
        queryKey: queryKeys.sessionTemplates.all,
      });
    },
  });
}

export const workspaceSessionTemplatesOverrideQuery = (workspaceId: string) =>
  queryOptions({
    queryKey: queryKeys.sessionTemplates.workspaceOverride(workspaceId),
    queryFn: async () =>
      unwrap(
        await api.api["session-templates"]
          .workspace({ workspaceId })
          .override.get(),
      ),
    enabled: !!workspaceId,
  });

export const workspaceOpenCodeConfigQuery = (workspaceId: string) =>
  queryOptions({
    queryKey: queryKeys.sessionTemplates.opencodeConfig(workspaceId),
    queryFn: async () =>
      unwrap(
        await api.api["session-templates"]
          .workspace({ workspaceId })
          ["opencode-config"].get(),
      ),
    enabled: !!workspaceId,
    staleTime: 30000,
  });

export const globalOpenCodeConfigQuery = queryOptions({
  queryKey: queryKeys.sessionTemplates.opencodeConfigGlobal,
  queryFn: async () =>
    unwrap(await api.api["session-templates"]["opencode-config"].get()),
  staleTime: 30000,
});

export function useUpdateWorkspaceSessionTemplates() {
  return useMutation({
    mutationKey: ["sessionTemplates", "updateWorkspace"],
    mutationFn: async ({
      workspaceId,
      templates,
    }: {
      workspaceId: string;
      templates: SessionTemplateInput[];
    }) =>
      unwrap(
        await api.api.workspaces({ id: workspaceId }).put({
          config: { sessionTemplates: templates },
        }),
      ),
    onSuccess: (_data, variables, _context, { client: queryClient }) => {
      queryClient.invalidateQueries({
        queryKey: queryKeys.sessionTemplates.all,
      });
      queryClient.invalidateQueries({
        queryKey: queryKeys.workspaces.detail(variables.workspaceId),
      });
    },
  });
}

// --- Config Files ---

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
    mutationKey: ["configFiles", "create"],
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
    mutationKey: ["configFiles", "update"],
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
    mutationKey: ["configFiles", "delete"],
    mutationFn: async (id: string) =>
      unwrap(await api.api["config-files"]({ id }).delete()),
    onSuccess: (_data, _variables, _context, { client: queryClient }) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.configFiles.all });
    },
  });
}

export function useSyncConfigsToSandboxes() {
  return useMutation({
    mutationKey: ["configFiles", "syncToSandboxes"],
    mutationFn: async () =>
      unwrap(await api.api["config-files"]["sync-to-sandboxes"].post()),
    onSuccess: (_data, _variables, _context, { client: queryClient }) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.configFiles.all });
    },
  });
}

// --- Shared Auth ---

export const sharedAuthListQuery = queryOptions({
  queryKey: ["sharedAuth", "list"] as const,
  queryFn: async () => unwrap(await api.api["shared-auth"].get()),
});

export function useUpdateSharedAuth() {
  return useMutation({
    mutationKey: ["sharedAuth", "update"],
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

// --- GitHub ---

export const githubStatusQuery = queryOptions({
  queryKey: queryKeys.github.status,
  queryFn: async () => unwrap(await api.api.github.status.get()),
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
    mutationKey: ["github", "logout"],
    mutationFn: async () => unwrap(await api.api.github.disconnect.post()),
    onSuccess: (_data, _variables, _context, { client: queryClient }) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.github.status });
    },
  });
}

export function useGitHubReauthorize() {
  return useMutation({
    mutationKey: ["github", "reauthorize"],
    mutationFn: async () => {
      window.location.href = `${API_HOST}/api/github/reauthorize`;
    },
  });
}

// --- Shared Storage ---

export const sharedStorageQuery = queryOptions({
  queryKey: queryKeys.sharedStorage.all,
  queryFn: async () => unwrap(await api.api.storage.get()),
  refetchInterval: 30000,
  refetchIntervalInBackground: false,
});

export function useInstallBinary() {
  return useMutation({
    mutationKey: ["sharedStorage", "installBinary"],
    mutationFn: async (id: string) =>
      unwrap(await api.api.storage.binaries({ id }).install.post()),
    onSuccess: (_data, _variables, _context, { client: queryClient }) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.sharedStorage.all });
    },
  });
}

export function useRemoveBinary() {
  return useMutation({
    mutationKey: ["sharedStorage", "removeBinary"],
    mutationFn: async (id: string) =>
      unwrap(await api.api.storage.binaries({ id }).delete()),
    onSuccess: (_data, _variables, _context, { client: queryClient }) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.sharedStorage.all });
    },
  });
}

// --- Registry ---

export const registryStatusQuery = queryOptions({
  queryKey: queryKeys.registry.status,
  queryFn: async () => unwrap(await api.api.registry.get()),
  refetchInterval: 30000,
  refetchIntervalInBackground: false,
});

export function useEnableRegistry() {
  return useMutation({
    mutationKey: ["registry", "enable"],
    mutationFn: async () => unwrap(await api.api.registry.enable.post({})),
    onSuccess: (_data, _variables, _context, { client: queryClient }) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.registry.status });
    },
  });
}

export function useDisableRegistry() {
  return useMutation({
    mutationKey: ["registry", "disable"],
    mutationFn: async () => unwrap(await api.api.registry.disable.post({})),
    onSuccess: (_data, _variables, _context, { client: queryClient }) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.registry.status });
    },
  });
}

export function useUpdateRegistrySettings() {
  return useMutation({
    mutationKey: ["registry", "settings"],
    mutationFn: async (data: { evictionDays?: number }) =>
      unwrap(await api.api.registry.settings.put(data)),
    onSuccess: (_data, _variables, _context, { client: queryClient }) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.registry.status });
    },
  });
}

export function usePurgeRegistryCache() {
  return useMutation({
    mutationKey: ["registry", "purge"],
    mutationFn: async () => unwrap(await api.api.registry.purge.post({})),
    onSuccess: (_data, _variables, _context, { client: queryClient }) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.registry.status });
      queryClient.invalidateQueries({ queryKey: queryKeys.system.storage });
    },
  });
}

export function useRunRegistryEviction() {
  return useMutation({
    mutationKey: ["registry", "evict"],
    mutationFn: async () => unwrap(await api.api.registry.evict.post({})),
    onSuccess: (_data, _variables, _context, { client: queryClient }) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.registry.status });
      queryClient.invalidateQueries({ queryKey: queryKeys.system.storage });
    },
  });
}

// --- SSH Keys ---

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
    mutationKey: ["sshKeys", "create"],
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
    mutationKey: ["sshKeys", "delete"],
    mutationFn: async (id: string) =>
      unwrap(await api.api["ssh-keys"]({ id }).delete()),
    onSuccess: (_data, _variables, _context, { client: queryClient }) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.sshKeys.all });
    },
  });
}
