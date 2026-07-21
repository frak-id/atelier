import {
  queryOptions,
  useMutation,
  useQueryClient,
} from "@tanstack/react-query";
import { toast } from "sonner";
import { api } from "@/api/client";
import { errorMessage } from "./error";
import { queryKeys } from "./keys";

export function secretsListQuery(orgId?: string) {
  return queryOptions({
    queryKey: queryKeys.secrets.list(orgId),
    queryFn: async () => {
      const { data, error } = await api.api.secrets.get({
        query: orgId ? { orgId } : {},
      });
      if (error) throw new Error(errorMessage(error, "Failed to load secrets"));
      return data;
    },
  });
}

export function useCreateSecret() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (body: {
      orgId?: string;
      name: string;
      value: string;
    }) => {
      const { error } = await api.api.secrets.post(body);
      if (error) throw new Error(errorMessage(error, "Failed to save secret"));
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.secrets.all });
      toast.success("Secret saved");
    },
    onError: (error) => toast.error(error.message),
  });
}

export function useDeleteSecret() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const { error } = await api.api.secrets({ id }).delete();
      if (error)
        throw new Error(errorMessage(error, "Failed to delete secret"));
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.secrets.all });
      toast.success("Secret deleted");
    },
    onError: (error) => toast.error(error.message),
  });
}
