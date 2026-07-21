import {
  queryOptions,
  useMutation,
  useQueryClient,
} from "@tanstack/react-query";
import { toast } from "sonner";
import { api } from "@/api/client";
import { errorMessage } from "./error";
import { queryKeys } from "./keys";

export function apiKeysListQuery() {
  return queryOptions({
    queryKey: queryKeys.apiKeys.list(),
    queryFn: async () => {
      const { data, error } = await api.api["api-keys"].get();
      if (error)
        throw new Error(errorMessage(error, "Failed to load API keys"));
      return data;
    },
  });
}

export function useCreateApiKey() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (body: { name: string; expiresAt?: string }) => {
      const { data, error } = await api.api["api-keys"].post(body);
      if (error)
        throw new Error(errorMessage(error, "Failed to create API key"));
      return data;
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
      const { error } = await api.api["api-keys"]({ id }).delete();
      if (error)
        throw new Error(errorMessage(error, "Failed to delete API key"));
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.apiKeys.all });
      toast.success("API key deleted");
    },
    onError: (error) => toast.error(error.message),
  });
}
