import {
  queryOptions,
  useMutation,
  useQueryClient,
} from "@tanstack/react-query";
import { toast } from "sonner";
import { api } from "@/api/client";
import { unwrap } from "./error";
import { queryKeys } from "./keys";

export function terminalSessionsQuery(sandboxId: string) {
  return queryOptions({
    queryKey: queryKeys.terminal.list(sandboxId),
    queryFn: async () => {
      return unwrap(
        await api.sessions.sandboxes({ id: sandboxId }).terminal.sessions.get(),
        "Terminal service unavailable",
      );
    },
    // Only enabled once the sandbox runs (MultiTerminal), so a failure is a
    // blip worth a couple of retries before showing the error and its Retry.
    retry: 2,
    retryDelay: 1_000,
  });
}

export function useCreateTerminalSession(sandboxId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (body: { title?: string }) => {
      return unwrap(
        await api.sessions
          .sandboxes({ id: sandboxId })
          .terminal.sessions.post(body),
        "Failed to create terminal",
      );
    },
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: queryKeys.terminal.all(sandboxId),
      });
    },
    onError: (error) => toast.error(error.message),
  });
}

export function useDeleteTerminalSession(sandboxId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (sessionId: string) => {
      unwrap(
        await api.sessions
          .sandboxes({ id: sandboxId })
          .terminal.sessions({ sessionId })
          .delete(),
        "Failed to delete terminal",
      );
    },
    // Drop the tab right away; the refetch below restores it if the delete
    // failed.
    onMutate: async (sessionId) => {
      const { queryKey } = terminalSessionsQuery(sandboxId);
      await queryClient.cancelQueries({ queryKey });
      queryClient.setQueryData(queryKey, (sessions) =>
        sessions?.filter((session) => session.id !== sessionId),
      );
    },
    onSettled: () => {
      queryClient.invalidateQueries({
        queryKey: queryKeys.terminal.all(sandboxId),
      });
    },
    onError: (error) => toast.error(error.message),
  });
}
