import type { PrebuildSpec } from "@atelier/spec";
import {
  queryOptions,
  useMutation,
  useQueryClient,
} from "@tanstack/react-query";
import { toast } from "sonner";
import { api } from "@/api/client";
import { errorMessage } from "./error";
import { queryKeys } from "./keys";

/** List stored prebuild snapshots (GET /v1/prebuilds) — the read side, for
 * the settings list and the spawn page's one-tap prebuild launcher. */
export function prebuildsListQuery() {
  return queryOptions({
    queryKey: queryKeys.prebuilds.list(),
    queryFn: async () => {
      const { data, error } = await api.v1.prebuilds.get();
      if (error)
        throw new Error(errorMessage(error, "Failed to load prebuilds"));
      return data;
    },
  });
}

/**
 * Run a chained, content-addressed repo prebuild (POST /v1/prebuilds): bake
 * `build[]`/`repos` into a VolumeSnapshot and get back its ref, usable as a
 * boot `source`. The repo tier beside the toolset tier
 * (composed-prebuild-volumes.md).
 */
export function useRunPrebuild() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (spec: PrebuildSpec) => {
      const { data, error } = await api.v1.prebuilds.post(spec);
      if (error) throw new Error(errorMessage(error, "Prebuild failed"));
      return data;
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.prebuilds.all });
      toast.success(`Prebuild snapshot: ${data?.ref ?? "created"}`);
    },
    onError: (error) => toast.error(error.message),
  });
}
