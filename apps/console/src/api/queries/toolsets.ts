import type { ToolsetBuildRequest } from "@atelier/spec";
import {
  queryOptions,
  useMutation,
  useQueryClient,
} from "@tanstack/react-query";
import { toast } from "sonner";
import { api } from "@/api/client";
import { unwrap } from "./error";
import { queryKeys } from "./keys";

export function toolsetsListQuery() {
  return queryOptions({
    queryKey: queryKeys.toolsets.list(),
    queryFn: async () => {
      return unwrap(await api.v1.toolsets.get(), "Failed to load toolsets");
    },
  });
}

function useInvalidateToolsets() {
  const queryClient = useQueryClient();
  return () => {
    queryClient.invalidateQueries({ queryKey: queryKeys.toolsets.all });
  };
}

// The build endpoint answers 202 with a `running` (or `queued`) job;
// the work proceeds in the background and is delivered to the queue over the
// SSE feed (`useJobEvents`), which also refreshes the toolsets list on
// completion. Mutations just kick the job off and report its initial state.

export function useBuildToolset() {
  return useMutation({
    mutationFn: async (req: ToolsetBuildRequest) => {
      return unwrap(await api.v1.toolsets.post(req), "Failed to build toolset");
    },
    onSuccess: (data) => {
      toast.success(
        data?.status === "queued"
          ? "Toolset build queued"
          : "Toolset build started",
      );
    },
    onError: (error) => toast.error(error.message),
  });
}

export function usePublishToolset() {
  const invalidate = useInvalidateToolsets();
  return useMutation({
    mutationFn: async (ref: string) => {
      return unwrap(
        await api.v1.toolsets.publish.post({ ref }),
        "Failed to publish toolset",
      );
    },
    onSuccess: () => {
      invalidate();
      toast.success("Toolset published");
    },
    onError: (error) => toast.error(error.message),
  });
}

export function useRemoveToolset() {
  const invalidate = useInvalidateToolsets();
  return useMutation({
    mutationFn: async (ref: string) => {
      unwrap(
        await api.v1.toolsets.delete(undefined, {
          query: { ref },
        }),
        "Failed to remove toolset",
      );
    },
    onSuccess: () => {
      invalidate();
      toast.success("Toolset removed");
    },
    onError: (error) => toast.error(error.message),
  });
}
