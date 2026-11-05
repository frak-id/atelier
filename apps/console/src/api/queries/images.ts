import {
  queryOptions,
  useMutation,
  useQueryClient,
} from "@tanstack/react-query";
import { toast } from "sonner";
import { api } from "@/api/client";
import { unwrap } from "./error";
import { queryKeys } from "./keys";

/** List registered/built base images (GET /v1/images) — the read side, for
 * the Images settings page and (eventually) a source-image picker. */
export function imagesListQuery() {
  return queryOptions({
    queryKey: queryKeys.images.list(),
    queryFn: async () => {
      return unwrap(await api.v1.images.get(), "Failed to load images");
    },
    staleTime: 30_000,
  });
}

/** List embedded seed templates (GET /v1/images/templates) — the
 * batteries-included Dockerfiles the server ships but never builds itself. */
export function imageTemplatesQuery() {
  return queryOptions({
    queryKey: queryKeys.images.templates(),
    queryFn: async () => {
      return unwrap(
        await api.v1.images.templates.get(),
        "Failed to load templates",
      );
    },
    staleTime: 60_000,
  });
}

/** Tail an image's build log (GET /v1/images/:name/logs). Polls every 2s
 * while the build is in flight, stops once it settles. */
export function imageLogsQuery(name: string) {
  return queryOptions({
    queryKey: queryKeys.images.logs(name),
    queryFn: async () => {
      return unwrap(
        await api.v1.images({ name }).logs.get(),
        "Failed to load logs",
      );
    },
    refetchInterval: (query) =>
      query.state.data?.status === "building" ? 2000 : false,
  });
}

/**
 * Build an embedded seed (POST /v1/images { seed, force? }). Returns
 * immediately with a `building` record — the log/status poll the console
 * runs separately. `force` bypasses the "already built" short-circuit, the
 * "rebuild" action on an existing seed-provenance image.
 */
export function useBuildSeed() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ seed, force }: { seed: string; force?: boolean }) => {
      return unwrap(await api.v1.images.post({ seed, force }), "Build failed");
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.images.all });
      toast.success(`Building ${data?.name ?? "image"}…`);
    },
    onError: (error) => toast.error(error.message),
  });
}

/** Register an externally-hosted image by reference, e.g. a GHCR tag
 * (POST /v1/images/register { name, ref }) — no build, ready immediately. */
export function useRegisterImage() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ name, ref }: { name: string; ref: string }) => {
      return unwrap(
        await api.v1.images.register.post({
          name,
          ref,
        }),
        "Failed to register image",
      );
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.images.all });
      toast.success(`Registered ${data?.name ?? "image"}`);
    },
    onError: (error) => toast.error(error.message),
  });
}

/**
 * Delete a stored image record (DELETE /v1/images/:name). Refused
 * server-side when a live sandbox or a stored snapshot still resolves its
 * boot image to this one — the console only offers it for unused ones.
 */
export function useDeleteImage() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (name: string) => {
      unwrap(await api.v1.images({ name }).delete(), "Failed to delete image");
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.images.all });
      toast.success("Image deleted");
    },
    onError: (error) => toast.error(error.message),
  });
}
