import {
  queryOptions,
  useMutation,
  useQueryClient,
} from "@tanstack/react-query";
import { toast } from "sonner";
import { api } from "@/api/client";
import { errorMessage } from "./error";
import { queryKeys } from "./keys";

export function terminalSessionsQuery(sandboxId: string) {
  return queryOptions({
    queryKey: queryKeys.terminal.list(sandboxId),
    queryFn: async () => {
      const { data, error } = await api.sessions
        .sandboxes({ id: sandboxId })
        .terminal.sessions.get();
      if (error)
        throw new Error(errorMessage(error, "Terminal service unavailable"));
      return data;
    },
    retry: false,
  });
}

export function useCreateTerminalSession(sandboxId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (body: { title?: string }) => {
      const { data, error } = await api.sessions
        .sandboxes({ id: sandboxId })
        .terminal.sessions.post(body);
      if (error)
        throw new Error(errorMessage(error, "Failed to create terminal"));
      return data;
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
      const { error } = await api.sessions
        .sandboxes({ id: sandboxId })
        .terminal.sessions({ sessionId })
        .delete();
      if (error)
        throw new Error(errorMessage(error, "Failed to delete terminal"));
    },
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: queryKeys.terminal.all(sandboxId),
      });
    },
    onError: (error) => toast.error(error.message),
  });
}
