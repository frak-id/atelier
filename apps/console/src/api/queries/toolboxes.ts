import type { ToolboxConfigInput, ToolboxConfigPatch } from "@atelier/spec";
import {
  queryOptions,
  useMutation,
  useQueryClient,
} from "@tanstack/react-query";
import { toast } from "sonner";
import { api } from "@/api/client";
import { unwrap } from "./error";
import { queryKeys } from "./keys";

/**
 * `owner` is the `?owner=` scope: `org:<id>`, or `me` (the caller's personal
 * org, the default when absent).
 */
export function toolboxesListQuery(owner?: string) {
  return queryOptions({
    queryKey: queryKeys.toolboxes.list(owner),
    queryFn: async () => {
      return unwrap(
        await api.api.toolboxes.get({
          query: owner ? { owner } : {},
        }),
        "Failed to load toolboxes",
      );
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
      unwrap(
        await api.api.toolboxes.post(input, {
          query: owner ? { owner } : {},
        }),
        "Failed to create toolbox",
      );
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
      unwrap(
        await api.api.toolboxes({ id }).patch(patch),
        "Failed to update toolbox",
      );
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
      return unwrap(
        await api.api.toolboxes({ id }).refresh.post(),
        "Failed to start the refresh",
      );
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
      unwrap(
        await api.api.toolboxes({ id }).delete(),
        "Failed to delete toolbox",
      );
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.toolboxes.all });
      toast.success("Toolbox deleted");
    },
    onError: (error) => toast.error(error.message),
  });
}
