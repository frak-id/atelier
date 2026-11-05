import {
  queryOptions,
  useMutation,
  useQueryClient,
} from "@tanstack/react-query";
import { toast } from "sonner";
import { api } from "@/api/client";
import { errorMessage } from "./error";
import { queryKeys } from "./keys";

// ── queries ──────────────────────────────────────────────────────────────

export function sessionsListQuery(sandboxId: string) {
  return queryOptions({
    queryKey: queryKeys.sessions.list(sandboxId),
    queryFn: async () => {
      const { data, error } = await api.sessions
        .sandboxes({ id: sandboxId })
        .agent.sessions.get();
      if (error)
        throw new Error(errorMessage(error, "Failed to load sessions"));
      return data;
    },
  });
}

export function sessionStatusesQuery(sandboxId: string) {
  return queryOptions({
    queryKey: queryKeys.sessions.statuses(sandboxId),
    queryFn: async () => {
      const { data, error } = await api.sessions
        .sandboxes({ id: sandboxId })
        .agent["session-statuses"].get();
      if (error)
        throw new Error(errorMessage(error, "Failed to load session statuses"));
      return data;
    },
  });
}

export function sessionTodosQuery(sandboxId: string, sessionId: string | null) {
  return queryOptions({
    queryKey: queryKeys.sessions.todos(sandboxId, sessionId ?? ""),
    queryFn: async () => {
      const { data, error } = await api.sessions
        .sandboxes({ id: sandboxId })
        .agent.sessions({ sessionId: sessionId ?? "" })
        .todos.get();
      if (error) throw new Error(errorMessage(error, "Failed to load todos"));
      return data;
    },
    enabled: sessionId !== null,
  });
}

// ── mutations ────────────────────────────────────────────────────────────

/**
 * Abort/delete take `{ sandboxId, sessionId }` as the mutation argument (not a
 * fixed `sandboxId` at hook-call time) so a single hook instance serves both
 * the per-sandbox sessions page and the fleet-wide mission-control home, where
 * rows span many sandboxes and can't bind one hook each without violating the
 * rules of hooks. Read the in-flight `sessionId` via `mutation.variables?.
 * sessionId`.
 */
export function useAbortSession() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({
      sandboxId,
      sessionId,
    }: {
      sandboxId: string;
      sessionId: string;
    }) => {
      const { error } = await api.sessions
        .sandboxes({ id: sandboxId })
        .agent.sessions({ sessionId })
        .abort.post();
      if (error)
        throw new Error(errorMessage(error, "Failed to abort session"));
      return sandboxId;
    },
    onSuccess: (sandboxId) => {
      queryClient.invalidateQueries({
        queryKey: queryKeys.sessions.statuses(sandboxId),
      });
      queryClient.invalidateQueries({
        queryKey: queryKeys.sessions.list(sandboxId),
      });
      toast.success("Session aborted");
    },
    onError: (error) => toast.error(error.message),
  });
}

export function useDeleteSession() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({
      sandboxId,
      sessionId,
    }: {
      sandboxId: string;
      sessionId: string;
    }) => {
      const { error } = await api.sessions
        .sandboxes({ id: sandboxId })
        .agent.sessions({ sessionId })
        .delete();
      if (error)
        throw new Error(errorMessage(error, "Failed to delete session"));
      return sandboxId;
    },
    onSuccess: (sandboxId) => {
      queryClient.invalidateQueries({
        queryKey: queryKeys.sessions.all(sandboxId),
      });
      toast.success("Session deleted");
    },
    onError: (error) => toast.error(error.message),
  });
}
