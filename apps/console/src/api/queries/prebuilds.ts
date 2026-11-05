import {
  type PrebuildRecord,
  type PrebuildSpec,
  prebuildRecipeKey,
  type RuntimeSurface,
  runtimeSurfaceOf,
  withoutSurface,
} from "@atelier/spec";
import {
  queryOptions,
  useMutation,
  useQueryClient,
} from "@tanstack/react-query";
import { toast } from "sonner";
import { api } from "@/api/client";
import { unwrap } from "./error";
import type { Job } from "./jobs";
import { queryKeys } from "./keys";

/** List stored prebuild snapshots (GET /v1/prebuilds) — the read side, for
 * the settings list and the spawn page's one-tap prebuild launcher. */
export function prebuildsListQuery() {
  return queryOptions({
    queryKey: queryKeys.prebuilds.list(),
    queryFn: async () => {
      return unwrap(await api.v1.prebuilds.get(), "Failed to load prebuilds");
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
      /** Human label for the toast (e.g. `owner/repo`). */
      label?: string;
    }) => {
      return unwrap(
        await api.v1.prebuilds.post(spec, {
          query: { force: force ?? false },
        }),
        "Prebuild failed",
      );
    },
    // The endpoint answers 202 with a `running` (or `queued`, if the pool is
    // full) job: the bake proceeds in the background. The SSE feed
    // (`useJobEvents`) owns the job's lifecycle in the queue cache, including
    // completion and the prebuilds-list refresh, so there is no invalidation
    // here (a refetch would race the stream). The one thing done here is to
    // seed the returned job when the feed hasn't delivered it yet, so a
    // repo row flips to "building" the instant the POST returns. It never
    // overwrites an existing entry: the feed may already hold a newer state.
    onSuccess: (job, { label }) => {
      if (job) {
        queryClient.setQueryData<Job[]>(queryKeys.jobs.list(), (prev) =>
          prev?.some((j) => j.id === job.id) ? prev : [job, ...(prev ?? [])],
        );
      }
      const verb = job?.status === "queued" ? "queued" : "started";
      toast.success(
        label ? `Prebuild ${verb} for ${label}` : `Prebuild ${verb}`,
      );
    },
    onError: (error) => toast.error(error.message),
  });
}

/**
 * Save a stored prebuild's dev servers (PATCH /v1/prebuilds/:ref/surface):
 * no content-key resolution and no bake, so it saves even when a repo got
 * new commits since the bake. Applied at boot, to every snapshot of the
 * recipe; empty lists clear them. The list shows the saved ones right away
 * (on every snapshot of the recipe, like the server), then refetches.
 */
export function useSavePrebuildSurface() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({
      ref,
      surface,
    }: {
      ref: string;
      surface: RuntimeSurface;
    }) => {
      return unwrap(
        await api.v1.prebuilds({ ref }).surface.patch({
          processes: surface.processes ?? [],
          ports: surface.ports ?? [],
        }),
        "Failed to save dev servers",
      );
    },
    onSuccess: (stored) => {
      if (stored) {
        const key = prebuildRecipeKey(stored);
        const surface = runtimeSurfaceOf(stored);
        queryClient.setQueryData<PrebuildRecord[]>(
          queryKeys.prebuilds.list(),
          (prev) =>
            prev?.map((p) =>
              p.spec && prebuildRecipeKey(p.spec) === key
                ? { ...p, spec: { ...withoutSurface(p.spec), ...surface } }
                : p,
            ),
        );
      }
      queryClient.invalidateQueries({ queryKey: queryKeys.prebuilds.all });
      toast.success("Dev servers saved");
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
      unwrap(
        await api.v1.prebuilds({ ref }).delete(),
        "Failed to delete prebuild",
      );
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.prebuilds.all });
      toast.success("Prebuild deleted");
    },
    onError: (error) => toast.error(error.message),
  });
}
