import {
  queryOptions,
  useMutation,
  useQueryClient,
} from "@tanstack/react-query";
import { toast } from "sonner";
import { api } from "@/api/client";
import { errorMessage } from "./error";
import { queryKeys } from "./keys";

export function orgPolicyQuery(orgId: string) {
  return queryOptions({
    queryKey: queryKeys.orgPolicy.detail(orgId),
    queryFn: async () => {
      const { data, error } = await api.api["org-policy"]({ orgId }).get();
      if (error) throw new Error(errorMessage(error, "Failed to load policy"));
      return data;
    },
  });
}

export function useSetOrgPolicy(orgId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (fragment: Record<string, unknown>) => {
      const { error } = await api.api["org-policy"]({ orgId }).put(fragment);
      if (error) throw new Error(errorMessage(error, "Failed to save policy"));
    },
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: queryKeys.orgPolicy.detail(orgId),
      });
      toast.success("Policy saved");
    },
    onError: (error) => toast.error(error.message),
  });
}
