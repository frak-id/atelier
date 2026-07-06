import type { SandboxSpec, TemplateMeta } from "@atelier/spec";
import {
  queryOptions,
  useMutation,
  useQueryClient,
} from "@tanstack/react-query";
import { toast } from "sonner";
import { api } from "@/api/client";
import { errorMessage } from "./error";
import { queryKeys } from "./keys";

// Template presentation types live in `@atelier/spec` (shared with the
// server's request validation + DB `$type`) — re-exported here so console
// callers keep importing them from the query module they already use.
export type { TemplateMeta, TemplateParam } from "@atelier/spec";

/** A saved spec as the console consumes it (a superset row from the list
 * endpoint). Defined once so rows/dialogs don't each re-declare a partial
 * shape (which is how `meta` got dropped on the edit path). */
export interface SavedSpec {
  id: string;
  orgId?: string;
  name: string;
  spec: SandboxSpec;
  template: boolean;
  meta?: TemplateMeta | null;
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
      template?: boolean;
      // Create never needs an explicit null (omit = no meta); only PATCH
      // accepts null, to clear.
      meta?: TemplateMeta;
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
      template?: boolean;
      meta?: TemplateMeta | null;
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
