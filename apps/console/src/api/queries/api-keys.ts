import {
  queryOptions,
  useMutation,
  useQueryClient,
} from "@tanstack/react-query";
import { toast } from "sonner";
import { api } from "@/api/client";
import { unwrap } from "./error";
import { queryKeys } from "./keys";

export function apiKeysListQuery() {
  return queryOptions({
    queryKey: queryKeys.apiKeys.list(),
    queryFn: async () => {
      return unwrap(await api.api["api-keys"].get(), "Failed to load API keys");
    },
  });
}

export function useCreateApiKey() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (body: { name: string; expiresAt?: string }) => {
      return unwrap(
        await api.api["api-keys"].post(body),
        "Failed to create API key",
      );
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.apiKeys.all });
    },
    onError: (error) => toast.error(error.message),
  });
}

export function useDeleteApiKey() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      unwrap(
        await api.api["api-keys"]({ id }).delete(),
        "Failed to delete API key",
      );
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.apiKeys.all });
      toast.success("API key deleted");
    },
    onError: (error) => toast.error(error.message),
  });
}
