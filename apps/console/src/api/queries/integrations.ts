import type { IntegrationConnectionInput } from "@frak/atelier-shared";
import {
  queryOptions,
  useMutation,
  useQueryClient,
} from "@tanstack/react-query";
import { toast } from "sonner";
import { api } from "@/api/client";
import { errorMessage } from "./error";
import { queryKeys } from "./keys";

export function integrationsListQuery() {
  return queryOptions({
    queryKey: queryKeys.integrations.list(),
    queryFn: async () => {
      const { data, error } = await api.api.integrations.get();
      if (error)
        throw new Error(errorMessage(error, "Failed to load integrations"));
      return data;
    },
  });
}

export function useSaveIntegrationConnection(id: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (body: IntegrationConnectionInput) => {
      const { data, error } = await api.api
        .integrations({ id })
        .connection.put(body);
      if (error)
        throw new Error(errorMessage(error, "Failed to save connection"));
      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.integrations.all });
      toast.success("Connection saved");
    },
    onError: (error) => toast.error(error.message),
  });
}

export function useDisconnectIntegration(id: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      const { error } = await api.api.integrations({ id }).connection.delete();
      if (error) throw new Error(errorMessage(error, "Failed to disconnect"));
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.integrations.all });
      toast.success("Disconnected");
    },
    onError: (error) => toast.error(error.message),
  });
}
