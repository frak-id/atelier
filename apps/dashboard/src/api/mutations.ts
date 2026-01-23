import type { TaskEffort } from "@frak-sandbox/shared/constants";
import { useMutation } from "@tanstack/react-query";
import { api } from "./client";
import { queryKeys } from "./query-keys";

function unwrap<T>(result: { data: T; error: unknown }): T {
  if (result.error) {
    throw result.error;
  }
  return result.data;
}

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
        await api.api
          .sandboxes({ id: sandboxId })
          .storage.resize.post({ sizeGb }),
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

export function useExtractConfig(sandboxId: string) {
  return useMutation({
    mutationFn: async (path: string) =>
      unwrap(
        await api.api
          .sandboxes({ id: sandboxId })
          .config.extract.post({ path }),
      ),
    onSuccess: (_data, _variables, _context, { client: queryClient }) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.configFiles.all });
    },
  });
}

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
        await api.api
          .tasks({ id })
          .delete({ query: { keepSandbox: keepSandbox ? "true" : undefined } }),
      ),
    onSuccess: (_data, _variables, _context, { client: queryClient }) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.tasks.all });
      queryClient.invalidateQueries({ queryKey: queryKeys.sandboxes.all });
    },
  });
}

export function useDeleteOpenCodeSession(baseUrl: string) {
  return useMutation({
    mutationFn: async (sessionId: string) => {
      const { deleteOpenCodeSession } = await import("./opencode");
      return deleteOpenCodeSession(baseUrl, sessionId);
    },
    onSuccess: (_data, _variables, _context, { client: queryClient }) => {
      queryClient.invalidateQueries({
        queryKey: queryKeys.opencode.sessions(baseUrl),
      });
    },
  });
}
