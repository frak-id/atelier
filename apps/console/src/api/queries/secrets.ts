import {
  queryOptions,
  useMutation,
  useQueryClient,
} from "@tanstack/react-query";
import { toast } from "sonner";
import { api } from "@/api/client";
import { unwrap } from "./error";
import { queryKeys } from "./keys";

export function secretsListQuery(orgId?: string) {
  return queryOptions({
    queryKey: queryKeys.secrets.list(orgId),
    queryFn: async () => {
      return unwrap(
        await api.api.secrets.get({
          query: orgId ? { orgId } : {},
        }),
        "Failed to load secrets",
      );
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
      unwrap(await api.api.secrets.post(body), "Failed to save secret");
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
      unwrap(await api.api.secrets({ id }).delete(), "Failed to delete secret");
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.secrets.all });
      toast.success("Secret deleted");
    },
    onError: (error) => toast.error(error.message),
  });
}
