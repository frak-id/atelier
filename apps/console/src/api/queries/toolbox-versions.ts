import {
  queryOptions,
  useMutation,
  useQueryClient,
} from "@tanstack/react-query";
import { toast } from "sonner";
import { api } from "@/api/client";
import { errorMessage } from "./error";
import { queryKeys } from "./keys";

/** Only mounted while a toolbox's versions panel is open — mount/unmount
 * gates it, same pattern as `processLogsQuery` (avoids N queries for N
 * toolboxes on the settings page). */
export function toolboxVersionsQuery(toolboxId: string) {
  return queryOptions({
    queryKey: queryKeys.toolboxVersions.list(toolboxId),
    queryFn: async () => {
      const { data, error } = await api.api
        .toolboxes({ id: toolboxId })
        .versions.get();
      if (error)
        throw new Error(errorMessage(error, "Failed to load versions"));
      return data;
    },
  });
}

export function useCaptureToolboxVersion() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({
      toolboxId,
      sandboxId,
      description,
    }: {
      toolboxId: string;
      sandboxId: string;
      description: string;
    }) => {
      const { data, error } = await api.api
        .toolboxes({ id: toolboxId })
        .versions.capture.post({ sandboxId, description });
      if (error) throw new Error(errorMessage(error, "Failed to save version"));
      return data;
    },
    onSuccess: (_data, { toolboxId }) => {
      queryClient.invalidateQueries({
        queryKey: queryKeys.toolboxVersions.list(toolboxId),
      });
      // A capture also creates a runtime toolset (docs/toolbox-versions.md
      // §7 step 2), so the toolsets list needs to reflect it too.
      queryClient.invalidateQueries({ queryKey: queryKeys.toolsets.all });
      toast.success("Saved as new version");
    },
    onError: (error) => toast.error(error.message),
  });
}

export function useSetActiveToolboxVersion() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({
      toolboxId,
      versionId,
    }: {
      toolboxId: string;
      versionId: string | null;
    }) => {
      const { data, error } = await api.api
        .toolboxes({ id: toolboxId })
        ["active-version"].put({ versionId });
      if (error)
        throw new Error(errorMessage(error, "Failed to update pinned version"));
      return data;
    },
    onSuccess: (_data, { toolboxId, versionId }) => {
      queryClient.invalidateQueries({
        queryKey: queryKeys.toolboxVersions.list(toolboxId),
      });
      queryClient.invalidateQueries({ queryKey: queryKeys.toolboxes.all });
      toast.success(versionId === null ? "Unpinned" : "Pinned version");
    },
    onError: (error) => toast.error(error.message),
  });
}

export function useDeleteToolboxVersion() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({
      toolboxId,
      versionId,
    }: {
      toolboxId: string;
      versionId: string;
    }) => {
      const { error } = await api.api
        .toolboxes({ id: toolboxId })
        .versions({ versionId })
        .delete();
      if (error)
        throw new Error(errorMessage(error, "Failed to delete version"));
    },
    onSuccess: (_data, { toolboxId }) => {
      queryClient.invalidateQueries({
        queryKey: queryKeys.toolboxVersions.list(toolboxId),
      });
      toast.success("Version deleted");
    },
    onError: (error) => toast.error(error.message),
  });
}
