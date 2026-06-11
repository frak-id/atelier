import { queryOptions, useMutation, useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { api } from "../client";
import { apiErrorMessage, queryKeys, unwrap } from "./keys";

export const sandboxListQuery = (filters?: {
  status?: string;
  workspaceId?: string;
  /**
   * Filter by `Sandbox.origin.source` (e.g. `"task"`, `"opencode-plugin"`).
   * Pairs with `originExternalId` to recover a specific sandbox without
   * persisting our own id→sandbox mapping. Mirrors the manager's
   * `?originSource=&originExternalId=` query.
   */
  originSource?: string;
  originExternalId?: string;
}) =>
  queryOptions({
    queryKey: queryKeys.sandboxes.list(filters),
    queryFn: async () =>
      unwrap(
        await api.api.sandboxes.get({
          query: filters as Record<string, string>,
        }),
      ),
  });

export const sandboxDetailQuery = (id: string) =>
  queryOptions({
    queryKey: queryKeys.sandboxes.detail(id),
    queryFn: async () => unwrap(await api.api.sandboxes({ id }).get()),
  });

export const allSandboxServicesQuery = queryOptions({
  queryKey: queryKeys.sandboxes.allServices,
  queryFn: async () => unwrap(await api.api.sandboxes["all-services"].get()),
  refetchInterval: 5000,
  refetchIntervalInBackground: false,
});

/**
 * Uses the batched all-services query with a selector to extract
 * services for a single sandbox. All components share the same
 * underlying request — no N+1 problem.
 */
export function useSandboxServices(sandboxId: string, enabled = true) {
  return useQuery({
    ...allSandboxServicesQuery,
    enabled,
    select: (data) => {
      const services = data?.[sandboxId];
      return services ? { services } : undefined;
    },
  });
}

export const serviceLogsQuery = (id: string, name: string, offset: number) =>
  queryOptions({
    queryKey: queryKeys.sandboxes.serviceLogs(id, name, offset),
    queryFn: async () =>
      unwrap(
        await api.api
          .sandboxes({ id })
          .services({ name })
          .logs.get({ query: { offset: offset.toString(), limit: "10000" } }),
      ),
    enabled: !!name,
    refetchInterval: 2000,
    refetchIntervalInBackground: false,
  });

export const sandboxGitStatusQuery = (id: string) =>
  queryOptions({
    queryKey: queryKeys.sandboxes.gitStatus(id),
    queryFn: async () =>
      unwrap(await api.api.sandboxes({ id }).git.status.get()),
    refetchInterval: 30000,
    refetchIntervalInBackground: false,
  });

export function useCreateSandbox() {
  return useMutation({
    mutationKey: ["sandboxes", "create"],
    mutationFn: async (data: {
      workspaceId?: string;
      baseImage?: string;
      vcpus?: number;
      memoryMb?: number;
    }) => unwrap(await api.api.sandboxes.post(data)),
    onSuccess: (_data, _variables, _context, { client: queryClient }) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.sandboxes.all });
      queryClient.invalidateQueries({ queryKey: queryKeys.system.stats });
    },
    onError: (error) => {
      toast.error(apiErrorMessage(error, "Failed to create sandbox"));
    },
  });
}

export function useRenameSandbox() {
  return useMutation({
    mutationKey: ["sandboxes", "rename"],
    mutationFn: async ({ id, name }: { id: string; name: string }) =>
      unwrap(await api.api.sandboxes({ id }).patch({ name })),
    onSuccess: (_data, variables, _context, { client: queryClient }) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.sandboxes.all });
      queryClient.invalidateQueries({
        queryKey: queryKeys.sandboxes.detail(variables.id),
      });
    },
  });
}

export function useDeleteSandbox() {
  return useMutation({
    mutationKey: ["sandboxes", "delete"],
    mutationFn: async (id: string) =>
      unwrap(await api.api.sandboxes({ id }).delete()),
    onSuccess: (_data, _variables, _context, { client: queryClient }) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.tasks.all });
      queryClient.invalidateQueries({ queryKey: queryKeys.sandboxes.all });
    },
  });
}

export function useStopSandbox() {
  return useMutation({
    mutationKey: ["sandboxes", "stop"],
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
    mutationKey: ["sandboxes", "start"],
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
    mutationKey: ["sandboxes", "restart"],
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

export function useRecoverSandbox() {
  return useMutation({
    mutationKey: ["sandboxes", "recover"],
    mutationFn: async (id: string) =>
      unwrap(await api.api.sandboxes({ id }).recover.post()),
    onSuccess: (_data, id, _context, { client: queryClient }) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.sandboxes.all });
      queryClient.invalidateQueries({
        queryKey: queryKeys.sandboxes.detail(id),
      });
    },
  });
}

export const sandboxGitDiffQuery = (id: string) =>
  queryOptions({
    queryKey: queryKeys.sandboxes.gitDiff(id),
    queryFn: async () => unwrap(await api.api.sandboxes({ id }).git.diff.get()),
    enabled: false,
  });

export function useGitCommit(sandboxId: string) {
  return useMutation({
    mutationKey: ["sandboxes", "git", "commit", sandboxId],
    mutationFn: async (data: { repoPath: string; message: string }) =>
      unwrap(await api.api.sandboxes({ id: sandboxId }).git.commit.post(data)),
    onSuccess: (_data, _variables, _context, { client: queryClient }) => {
      queryClient.invalidateQueries({
        queryKey: queryKeys.sandboxes.gitStatus(sandboxId),
      });
      queryClient.invalidateQueries({
        queryKey: queryKeys.sandboxes.gitDiff(sandboxId),
      });
    },
  });
}

export function useGitPush(sandboxId: string) {
  return useMutation({
    mutationKey: ["sandboxes", "git", "push", sandboxId],
    mutationFn: async (repoPath: string) =>
      unwrap(
        await api.api.sandboxes({ id: sandboxId }).git.push.post({ repoPath }),
      ),
    onSuccess: (_data, _variables, _context, { client: queryClient }) => {
      queryClient.invalidateQueries({
        queryKey: queryKeys.sandboxes.gitStatus(sandboxId),
      });
      queryClient.invalidateQueries({
        queryKey: queryKeys.sandboxes.gitDiff(sandboxId),
      });
    },
  });
}

export type ToolStatus = "running" | "starting" | "off";

export const sandboxToolsQuery = (id: string) =>
  queryOptions({
    queryKey: queryKeys.sandboxes.tools(id),
    queryFn: async () => unwrap(await api.api.sandboxes({ id }).tools.get()),
  });

export function deriveToolStatus(
  services:
    | { services: Array<{ name: string; running: boolean }> }
    | null
    | undefined,
  tool: { services: string[] } | null | undefined,
): ToolStatus {
  const primary = tool?.services?.[0];
  if (!primary) return "off";
  const svc = services?.services?.find((s) => s.name === primary);
  return svc?.running ? "running" : "off";
}

export function useStartTool(sandboxId: string) {
  return useMutation({
    mutationKey: ["sandboxes", "tools", "start", sandboxId],
    mutationFn: async (slug: string) =>
      unwrap(
        await api.api.sandboxes({ id: sandboxId }).tools({ slug }).start.post(),
      ),
    onSuccess: (_data, _variables, _context, { client: queryClient }) => {
      queryClient.invalidateQueries({
        queryKey: queryKeys.sandboxes.allServices,
      });
      queryClient.invalidateQueries({
        queryKey: queryKeys.sandboxes.detail(sandboxId),
      });
    },
  });
}

export function useStopTool(sandboxId: string) {
  return useMutation({
    mutationKey: ["sandboxes", "tools", "stop", sandboxId],
    mutationFn: async (slug: string) =>
      unwrap(
        await api.api.sandboxes({ id: sandboxId }).tools({ slug }).stop.post(),
      ),
    onSuccess: (_data, _variables, _context, { client: queryClient }) => {
      queryClient.invalidateQueries({
        queryKey: queryKeys.sandboxes.allServices,
      });
      queryClient.invalidateQueries({
        queryKey: queryKeys.sandboxes.detail(sandboxId),
      });
    },
  });
}

export function useServiceStop(sandboxId: string) {
  return useMutation({
    mutationKey: ["sandboxes", "services", "stop", sandboxId],
    mutationFn: async (name: string) =>
      unwrap(
        await api.api
          .sandboxes({ id: sandboxId })
          .services({ name })
          .stop.post(),
      ),
    onSuccess: (_data, _variables, _context, { client: queryClient }) => {
      queryClient.invalidateQueries({
        queryKey: queryKeys.sandboxes.allServices,
      });
    },
  });
}

export function useServiceStart(sandboxId: string) {
  return useMutation({
    mutationKey: ["sandboxes", "services", "start", sandboxId],
    mutationFn: async (name: string) =>
      unwrap(
        await api.api
          .sandboxes({ id: sandboxId })
          .services({ name })
          .start.post(),
      ),
    onSuccess: (_data, _variables, _context, { client: queryClient }) => {
      queryClient.invalidateQueries({
        queryKey: queryKeys.sandboxes.allServices,
      });
    },
  });
}

export function useSaveAsPrebuild() {
  return useMutation({
    mutationKey: ["sandboxes", "saveAsPrebuild"],
    mutationFn: async (sandboxId: string) =>
      unwrap(await api.api.sandboxes({ id: sandboxId }).promote.post()),
    onSuccess: (_data, _variables, _context, { client: queryClient }) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.workspaces.all });
      queryClient.invalidateQueries({ queryKey: queryKeys.sandboxes.all });
    },
  });
}

export interface TerminalSession {
  id: string;
  userId: string;
  title: string;
  createdAt: string;
}

export const terminalSessionsQuery = (sandboxId: string) =>
  queryOptions({
    queryKey: queryKeys.sandboxes.terminalSessions(sandboxId),
    queryFn: async () =>
      unwrap(
        await api.api.sandboxes({ id: sandboxId }).terminal.sessions.get(),
      ) as TerminalSession[],
    refetchInterval: 5000,
  });

export function useCreateTerminalSession(sandboxId: string) {
  return useMutation({
    mutationKey: ["sandboxes", "terminal", "create", sandboxId],
    mutationFn: async (title?: string) =>
      unwrap(
        await api.api.sandboxes({ id: sandboxId }).terminal.sessions.post({
          title,
        }),
      ) as TerminalSession,
    onSuccess: (_data, _variables, _context, { client: queryClient }) => {
      queryClient.invalidateQueries({
        queryKey: queryKeys.sandboxes.terminalSessions(sandboxId),
      });
    },
  });
}

export function useDeleteTerminalSession(sandboxId: string) {
  return useMutation({
    mutationKey: ["sandboxes", "terminal", "delete", sandboxId],
    mutationFn: async (sessionId: string) =>
      unwrap(
        await api.api
          .sandboxes({ id: sandboxId })
          .terminal.sessions({ sessionId })
          .delete(),
      ),
    onSuccess: (_data, _variables, _context, { client: queryClient }) => {
      queryClient.invalidateQueries({
        queryKey: queryKeys.sandboxes.terminalSessions(sandboxId),
      });
    },
  });
}
