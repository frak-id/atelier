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
    staleTime: 30_000,
  });
}

/**
 * Run a chained, content-addressed repo prebuild (POST /v1/prebuilds): bake
 * `build[]`/`repos` into a VolumeSnapshot and get back its ref, usable as a
 * boot `source`. The repo tier beside the toolset tier
 * (composed-prebuild-volumes.md). `force` bypasses the content-hash cache hit
 * — the "rebuild" action on an existing prebuild.
 */
export function useRunPrebuild() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({
      spec,
      force,
    }: {
      spec: PrebuildSpec;
      force?: boolean;
    }) => {
      const { data, error } = await api.v1.prebuilds.post(spec, {
        query: { force: force ?? false },
      });
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

/**
 * Delete a stored prebuild snapshot (DELETE /v1/prebuilds/:ref). Refused
 * server-side when the snapshot is still in use (a sandbox boots from it or a
 * prebuild is chained on it) — the console only offers it for unused ones.
 */
export function useDeletePrebuild() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (ref: string) => {
      const { error } = await api.v1.prebuilds({ ref }).delete();
      if (error)
        throw new Error(errorMessage(error, "Failed to delete prebuild"));
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.prebuilds.all });
      toast.success("Prebuild deleted");
    },
    onError: (error) => toast.error(error.message),
  });
}
