import {
  queryOptions,
  useMutation,
  useQueryClient,
} from "@tanstack/react-query";
import { toast } from "sonner";
import { api } from "@/api/client";
import { errorMessage } from "./error";
import { queryKeys } from "./keys";

/** List registered/built base images (GET /v1/images) — the read side, for
 * the Images settings page and (eventually) a source-image picker. */
export function imagesListQuery() {
  return queryOptions({
    queryKey: queryKeys.images.list(),
    queryFn: async () => {
      const { data, error } = await api.v1.images.get();
      if (error) throw new Error(errorMessage(error, "Failed to load images"));
      return data;
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
      const { data, error } = await api.v1.images.templates.get();
      if (error)
        throw new Error(errorMessage(error, "Failed to load templates"));
      return data;
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
      const { data, error } = await api.v1.images({ name }).logs.get();
      if (error) throw new Error(errorMessage(error, "Failed to load logs"));
      return data;
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
      const { data, error } = await api.v1.images.post({ seed, force });
      if (error) throw new Error(errorMessage(error, "Build failed"));
      return data;
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.images.all });
      toast.success(`Building ${data?.name ?? "image"}…`);
    },
    onError: (error) => toast.error(error.message),
  });
}

/**
 * Build a user-supplied Dockerfile (POST /v1/images { name, dockerfile }) —
 * BYO content, or the "rebuild" action replaying a stored
 * `dockerfile`-provenance image's saved source.
 */
export function useBuildDockerfile() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({
      name,
      dockerfile,
    }: {
      name: string;
      dockerfile: string;
    }) => {
      const { data, error } = await api.v1.images.post({ name, dockerfile });
      if (error) throw new Error(errorMessage(error, "Build failed"));
      return data;
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.images.all });
      toast.success(`Building ${data?.name ?? "image"}…`);
    },
    onError: (error) => toast.error(error.message),
  });
}

/**
 * Build from an uploaded zip build context (POST /v1/images/upload,
 * multipart). The zip must contain a `Dockerfile` at its root; the server
 * unpacks it (size-capped, traversal-guarded) and builds it. Returns
 * immediately with the `building` record — same async poll as the other
 * builds.
 */
export function useUploadImage() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ name, file }: { name: string; file: File }) => {
      const { data, error } = await api.v1.images.upload.post({ name, file });
      if (error) throw new Error(errorMessage(error, "Upload failed"));
      return data;
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
      const { data, error } = await api.v1.images.register.post({
        name,
        ref,
      });
      if (error)
        throw new Error(errorMessage(error, "Failed to register image"));
      return data;
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
      const { error } = await api.v1.images({ name }).delete();
      if (error) throw new Error(errorMessage(error, "Failed to delete image"));
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.images.all });
      toast.success("Image deleted");
    },
    onError: (error) => toast.error(error.message),
  });
}
