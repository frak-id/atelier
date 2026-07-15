import type { SandboxSpec } from "@atelier/spec";
import {
  queryOptions,
  useMutation,
  useQueryClient,
} from "@tanstack/react-query";
import { toast } from "sonner";
import { api } from "@/api/client";
import { errorMessage } from "./error";
import { queryKeys } from "./keys";

/** A saved spec as the console consumes it (a row from the list endpoint). */
export interface SavedSpec {
  id: string;
  orgId?: string;
  name: string;
  spec: SandboxSpec;
  updatedAt: string;
}

export function savedSpecsListQuery() {
  return queryOptions({
    queryKey: queryKeys.savedSpecs.list(),
    queryFn: async () => {
      const { data, error } = await api.api["saved-specs"].get();
      if (error)
        throw new Error(errorMessage(error, "Failed to list saved specs"));
      return data;
    },
    staleTime: 30_000,
  });
}

function useInvalidateSavedSpecs() {
  const queryClient = useQueryClient();
  return () =>
    queryClient.invalidateQueries({ queryKey: queryKeys.savedSpecs.all });
}

export function useCreateSavedSpec() {
  const invalidate = useInvalidateSavedSpecs();
  return useMutation({
    mutationFn: async (body: {
      name: string;
      spec: SandboxSpec;
      orgId?: string;
    }) => {
      const { data, error } = await api.api["saved-specs"].post(body);
      if (error) throw new Error(errorMessage(error, "Failed to save spec"));
      return data;
    },
    onSuccess: (_data, { name }) => {
      invalidate();
      toast.success(`Saved spec "${name}" created`);
    },
    onError: (error) => toast.error(error.message),
  });
}

export function useUpdateSavedSpec() {
  const invalidate = useInvalidateSavedSpecs();
  return useMutation({
    mutationFn: async ({
      id,
      ...body
    }: {
      id: string;
      name?: string;
      spec?: SandboxSpec;
    }) => {
      const { data, error } = await api.api["saved-specs"]({ id }).patch(body);
      if (error)
        throw new Error(errorMessage(error, "Failed to update saved spec"));
      return data;
    },
    onSuccess: () => {
      invalidate();
      toast.success("Saved spec updated");
    },
    onError: (error) => toast.error(error.message),
  });
}

export function useDeleteSavedSpec() {
  const invalidate = useInvalidateSavedSpecs();
  return useMutation({
    mutationFn: async (id: string) => {
      const { error } = await api.api["saved-specs"]({ id }).delete();
      if (error)
        throw new Error(errorMessage(error, "Failed to delete saved spec"));
    },
    onSuccess: () => {
      invalidate();
      toast.success("Saved spec deleted");
    },
    onError: (error) => toast.error(error.message),
  });
}
