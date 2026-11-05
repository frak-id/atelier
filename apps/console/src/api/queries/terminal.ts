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
    retry: false,
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
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: queryKeys.terminal.all(sandboxId),
      });
    },
    onError: (error) => toast.error(error.message),
  });
}
