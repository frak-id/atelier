import type { SteeryNotifyPolicy } from "@frak/atelier-shared";
import {
  queryOptions,
  useMutation,
  useQueryClient,
} from "@tanstack/react-query";
import { toast } from "sonner";
import { api } from "@/api/client";
import { errorMessage } from "./error";
import { queryKeys } from "./keys";

export function steeryNotifyQuery(orgId: string) {
  return queryOptions({
    queryKey: queryKeys.steeryNotify.detail(orgId),
    queryFn: async () => {
      const { data, error } = await api.api["steery-notify"]({ orgId }).get();
      if (error) {
        throw new Error(errorMessage(error, "Failed to load Steery settings"));
      }
      return data;
    },
  });
}

export function useSetSteeryNotify(orgId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (body: SteeryNotifyPolicy & { apiKey?: string }) => {
      const { error } = await api.api["steery-notify"]({ orgId }).put(body);
      if (error) {
        throw new Error(errorMessage(error, "Failed to save Steery settings"));
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: queryKeys.steeryNotify.detail(orgId),
      });
      toast.success("Steery settings saved");
    },
    onError: (error) => toast.error(error.message),
  });
}
