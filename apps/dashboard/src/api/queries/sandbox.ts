import { queryOptions, useMutation } from "@tanstack/react-query";
import { api } from "../client";
import { queryKeys, unwrap } from "./keys";

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
  });

export const sandboxDetailQuery = (id: string) =>
  queryOptions({
    queryKey: queryKeys.sandboxes.detail(id),
    queryFn: async () => unwrap(await api.api.sandboxes({ id }).get()),
  });

export const sandboxMetricsQuery = (id: string) =>
  queryOptions({
    queryKey: queryKeys.sandboxes.metrics(id),
    queryFn: async () => unwrap(await api.api.sandboxes({ id }).metrics.get()),
    refetchInterval: 10000,
    refetchIntervalInBackground: false,
  });

export const sandboxServicesQuery = (id: string) =>
  queryOptions({
    queryKey: queryKeys.sandboxes.services(id),
    queryFn: async () => unwrap(await api.api.sandboxes({ id }).services.get()),
    refetchInterval: 30000,
    refetchIntervalInBackground: false,
  });

export const sandboxDevCommandsQuery = (id: string) =>
  queryOptions({
    queryKey: queryKeys.sandboxes.devCommands(id),
    queryFn: async () => unwrap(await api.api.sandboxes({ id }).dev.get()),
  });

export const sandboxDevCommandLogsQuery = (
  id: string,
  name: string,
  offset: number,
) =>
  queryOptions({
    queryKey: queryKeys.sandboxes.devCommandLogs(id, name, offset),
    queryFn: async () =>
      unwrap(
        await api.api
          .sandboxes({ id })
          .dev({ name })
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

export function useStartDevCommand(sandboxId: string) {
  return useMutation({
    mutationKey: ["sandboxes", "dev", "start", sandboxId],
    mutationFn: async (name: string) =>
      unwrap(
        await api.api.sandboxes({ id: sandboxId }).dev({ name }).start.post(),
      ),
    onSuccess: (_data, _variables, _context, { client: queryClient }) => {
      queryClient.invalidateQueries({
        queryKey: queryKeys.sandboxes.devCommands(sandboxId),
      });
    },
  });
}

export function useStopDevCommand(sandboxId: string) {
  return useMutation({
    mutationKey: ["sandboxes", "dev", "stop", sandboxId],
    mutationFn: async (name: string) =>
      unwrap(
        await api.api.sandboxes({ id: sandboxId }).dev({ name }).stop.post(),
      ),
    onSuccess: (_data, _variables, _context, { client: queryClient }) => {
      queryClient.invalidateQueries({
        queryKey: queryKeys.sandboxes.devCommands(sandboxId),
      });
    },
  });
}

export function useResizeStorage(sandboxId: string) {
  return useMutation({
    mutationKey: ["sandboxes", "resizeStorage", sandboxId],
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

export function deriveBrowserStatus(
  services:
    | { services: Array<{ name: string; running: boolean }> }
    | null
    | undefined,
  sandbox: { runtime: { urls: { browser?: string } } } | null | undefined,
): { status: "running" | "starting" | "off"; url?: string } {
  const browserUrl = sandbox?.runtime?.urls?.browser;
  if (!browserUrl) return { status: "off" };

  const kasmvnc = services?.services?.find((s) => s.name === "kasmvnc");
  if (!kasmvnc) return { status: "off" };
  if (kasmvnc.running) return { status: "running", url: browserUrl };
  return { status: "starting", url: browserUrl };
}

export function useStartBrowser(sandboxId: string) {
  return useMutation({
    mutationKey: ["sandboxes", "browser", "start", sandboxId],
    mutationFn: async () =>
      unwrap(await api.api.sandboxes({ id: sandboxId }).browser.start.post()),
    onSuccess: (_data, _variables, _context, { client: queryClient }) => {
      queryClient.invalidateQueries({
        queryKey: queryKeys.sandboxes.services(sandboxId),
      });
      queryClient.invalidateQueries({
        queryKey: queryKeys.sandboxes.detail(sandboxId),
      });
    },
  });
}

export function useStopBrowser(sandboxId: string) {
  return useMutation({
    mutationKey: ["sandboxes", "browser", "stop", sandboxId],
    mutationFn: async () =>
      unwrap(await api.api.sandboxes({ id: sandboxId }).browser.stop.post()),
    onSuccess: (_data, _variables, _context, { client: queryClient }) => {
      queryClient.invalidateQueries({
        queryKey: queryKeys.sandboxes.services(sandboxId),
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
        queryKey: queryKeys.sandboxes.services(sandboxId),
      });
    },
  });
}

export function useServiceRestart(sandboxId: string) {
  return useMutation({
    mutationKey: ["sandboxes", "services", "restart", sandboxId],
    mutationFn: async (name: string) =>
      unwrap(
        await api.api
          .sandboxes({ id: sandboxId })
          .services({ name })
          .restart.post(),
      ),
    onSuccess: (_data, _variables, _context, { client: queryClient }) => {
      queryClient.invalidateQueries({
        queryKey: queryKeys.sandboxes.services(sandboxId),
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
