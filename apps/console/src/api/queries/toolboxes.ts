import type { ToolboxConfigInput, ToolboxConfigPatch } from "@atelier/spec";
import {
  queryOptions,
  useMutation,
  useQueryClient,
} from "@tanstack/react-query";
import { toast } from "sonner";
import { api } from "@/api/client";
import { errorMessage } from "./error";
import { queryKeys } from "./keys";

export function toolboxesListQuery(orgId?: string) {
  return queryOptions({
    queryKey: queryKeys.toolboxes.list(orgId),
    queryFn: async () => {
      const { data, error } = await api.api.toolboxes.get({
        query: orgId ? { orgId } : {},
      });
      if (error)
        throw new Error(errorMessage(error, "Failed to load toolboxes"));
      return data;
    },
  });
}

export function useCreateToolbox() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (body: ToolboxConfigInput & { orgId?: string }) => {
      const { error } = await api.api.toolboxes.post(body);
      if (error)
        throw new Error(errorMessage(error, "Failed to create toolbox"));
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.toolboxes.all });
      toast.success("Toolbox saved");
    },
    onError: (error) => toast.error(error.message),
  });
}

export function useUpdateToolbox() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({
      id,
      patch,
    }: {
      id: string;
      patch: ToolboxConfigPatch;
    }) => {
      const { error } = await api.api.toolboxes({ id }).patch(patch);
      if (error)
        throw new Error(errorMessage(error, "Failed to update toolbox"));
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.toolboxes.all });
      toast.success("Toolbox saved");
    },
    onError: (error) => toast.error(error.message),
  });
}

export function useDeleteToolbox() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const { error } = await api.api.toolboxes({ id }).delete();
      if (error)
        throw new Error(errorMessage(error, "Failed to delete toolbox"));
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.toolboxes.all });
      toast.success("Toolbox deleted");
    },
    onError: (error) => toast.error(error.message),
  });
}
