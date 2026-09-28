import type { ToolboxVersion } from "@atelier/spec";
import {
  queryOptions,
  useMutation,
  useQueryClient,
} from "@tanstack/react-query";
import { toast } from "sonner";
import { api } from "@/api/client";
import { errorMessage } from "./error";
import { queryKeys } from "./keys";

/** A version row as returned by `GET /toolboxes/:id/versions`: the stored
 * row plus its artifact's current sharing state (`null` if the artifact
 * record is missing). */
export interface ToolboxVersionWithArtifact extends ToolboxVersion {
  artifact: { private: boolean; paths: string[] } | null;
}

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
    // 202 + a `running`/`queued` job: the agent tar/scan/push runs in the
    // background. The job is delivered to the queue over the SSE feed
    // (`useJobEvents`), and the version row + toolsets list refresh land on
    // its completion the same way.
    onSuccess: (data) => {
      toast.success(
        data?.status === "queued" ? "Capture queued" : "Capture started",
      );
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

/** Flips a version's artifact from private to shareable (`private: false`).
 * Same bytes, same digest — publishing never changes what a pin replays;
 * it only widens who may pin/move it. */
export function usePublishToolboxVersion() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({
      toolboxId,
      versionId,
    }: {
      toolboxId: string;
      versionId: string;
    }) => {
      const { data, error } = await api.api
        .toolboxes({ id: toolboxId })
        .versions({ versionId })
        .publish.post();
      if (error)
        throw new Error(errorMessage(error, "Failed to publish version"));
      return data;
    },
    onSuccess: (_data, { toolboxId }) => {
      queryClient.invalidateQueries({
        queryKey: queryKeys.toolboxVersions.list(toolboxId),
      });
      queryClient.invalidateQueries({ queryKey: queryKeys.toolsets.all });
      queryClient.invalidateQueries({ queryKey: queryKeys.transfers.all });
      toast.success("Version published");
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
