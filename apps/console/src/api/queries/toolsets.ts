import type { ToolsetBuildRequest, ToolsetCaptureRequest } from "@atelier/spec";
import {
  queryOptions,
  useMutation,
  useQueryClient,
} from "@tanstack/react-query";
import { toast } from "sonner";
import { api } from "@/api/client";
import { errorMessage } from "./error";
import { queryKeys } from "./keys";

export function toolsetsListQuery() {
  return queryOptions({
    queryKey: queryKeys.toolsets.list(),
    queryFn: async () => {
      const { data, error } = await api.v1.toolsets.get();
      if (error)
        throw new Error(errorMessage(error, "Failed to load toolsets"));
      return data;
    },
  });
}

function useInvalidateToolsets() {
  const queryClient = useQueryClient();
  return () => {
    queryClient.invalidateQueries({ queryKey: queryKeys.toolsets.all });
  };
}

export function useBuildToolset() {
  const invalidate = useInvalidateToolsets();
  return useMutation({
    mutationFn: async (req: ToolsetBuildRequest) => {
      const { data, error } = await api.v1.toolsets.post(req);
      if (error)
        throw new Error(errorMessage(error, "Failed to build toolset"));
      return data;
    },
    onSuccess: () => {
      invalidate();
      toast.success("Toolset built");
    },
    onError: (error) => toast.error(error.message),
  });
}

export function usePublishToolset() {
  const invalidate = useInvalidateToolsets();
  return useMutation({
    mutationFn: async (ref: string) => {
      const { data, error } = await api.v1.toolsets.publish.post({ ref });
      if (error)
        throw new Error(errorMessage(error, "Failed to publish toolset"));
      return data;
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
      const { error } = await api.v1.toolsets.delete({ ref });
      if (error)
        throw new Error(errorMessage(error, "Failed to remove toolset"));
    },
    onSuccess: () => {
      invalidate();
      toast.success("Toolset removed");
    },
    onError: (error) => toast.error(error.message),
  });
}

export function useCaptureToolset() {
  const invalidate = useInvalidateToolsets();
  return useMutation({
    mutationFn: async ({
      sandboxId,
      ...req
    }: ToolsetCaptureRequest & { sandboxId: string }) => {
      const { data, error } = await api.v1
        .sandboxes({ id: sandboxId })
        .toolsets.capture.post(req);
      if (error)
        throw new Error(errorMessage(error, "Failed to capture toolset"));
      return data;
    },
    onSuccess: () => {
      invalidate();
      toast.success("Toolset captured");
    },
    onError: (error) => toast.error(error.message),
  });
}
