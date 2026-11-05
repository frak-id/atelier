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

/**
 * `owner` is the `?owner=` scope: `org:<id>`, or `me` (the caller's personal
 * org, the default when absent).
 */
export function toolboxesListQuery(owner?: string) {
  return queryOptions({
    queryKey: queryKeys.toolboxes.list(owner),
    queryFn: async () => {
      const { data, error } = await api.api.toolboxes.get({
        query: owner ? { owner } : {},
      });
      if (error)
        throw new Error(errorMessage(error, "Failed to load toolboxes"));
      return data;
    },
    staleTime: 30_000,
  });
}

export function useCreateToolbox() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({
      input,
      owner,
    }: {
      input: ToolboxConfigInput;
      owner?: string;
    }) => {
      const { error } = await api.api.toolboxes.post(input, {
        query: owner ? { owner } : {},
      });
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

/**
 * Start a refresh (POST /api/toolboxes/:id/refresh): the server runs the
 * toolbox's update commands over its current version and pins the result.
 * Answers `202` with the job (or the one already running for this toolbox);
 * the SSE feed (`useJobEvents`) delivers its progress and outcome.
 */
export function useRefreshToolbox() {
  return useMutation({
    mutationFn: async (id: string) => {
      const { data, error } = await api.api.toolboxes({ id }).refresh.post();
      if (error)
        throw new Error(errorMessage(error, "Failed to start the refresh"));
      return data;
    },
    onSuccess: (job) => {
      toast.success(
        job?.status === "queued" ? "Refresh queued" : "Refresh started",
      );
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
