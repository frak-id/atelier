import type { CreateSandboxRequest } from "@atelier/spec";
import {
  queryOptions,
  useMutation,
  useQueryClient,
} from "@tanstack/react-query";
import { toast } from "sonner";
import { api } from "@/api/client";
import { ApiError, unwrap } from "./error";
import { queryKeys } from "./keys";

// ── queries ──────────────────────────────────────────────────────────────

export function sandboxListQuery() {
  return queryOptions({
    queryKey: queryKeys.sandboxes.list(),
    queryFn: async () => {
      return unwrap(await api.v1.sandboxes.get(), "Failed to list sandboxes");
    },
    // No polling: the job feed (`useJobEvents`) invalidates the list when a
    // spawn/pause/resume/destroy settles, idle auto-pauses included.
  });
}

export function sandboxDetailQuery(id: string) {
  return queryOptions({
    queryKey: queryKeys.sandboxes.detail(id),
    queryFn: async () => {
      return unwrap(
        await api.v1.sandboxes({ id }).get(),
        "Failed to load sandbox",
      );
    },
    // A just-spawned sandbox is created asynchronously: `POST /sandboxes`
    // answers 202 + job (the console navigates here immediately) before the
    // `creating` record lands, so the first GET can 404 for a brief window
    // (longer when the base image needs a live registry resolve). Retry 404s
    // so the page stays in its loading skeleton and flips to the sandbox once
    // the record appears, instead of flashing a "not found" error. Real
    // failures (non-404) surface immediately.
    retry: (count, err) =>
      err instanceof ApiError && err.status === 404 && count < 8,
    retryDelay: 1000,
    // Fast while it boots, then a slow refresh for process health; lifecycle
    // changes arrive through the job feed.
    refetchInterval: (query) =>
      query.state.data?.status === "creating" ? 2_000 : 30_000,
  });
}

/** Idle auto-pause view: the rule applied to this sandbox, its activity
 * clocks and the last hour of agent measurements. The server refreshes it
 * once a minute (reading it never calls the agent). */
export function sandboxActivityQuery(id: string) {
  return queryOptions({
    queryKey: queryKeys.sandboxes.activity(id),
    queryFn: async () => {
      return unwrap(
        await api.v1.sandboxes({ id }).activity.get(),
        "Failed to load activity",
      );
    },
    refetchInterval: 30_000,
  });
}

// ── mutations ────────────────────────────────────────────────────────────

/** Prefix invalidation: `sandboxes.all` covers the list and every detail. */
function useInvalidateSandboxes() {
  const queryClient = useQueryClient();
  return () => {
    queryClient.invalidateQueries({ queryKey: queryKeys.sandboxes.all });
  };
}

export function usePauseSandbox() {
  const invalidate = useInvalidateSandboxes();
  return useMutation({
    mutationFn: async (id: string) => {
      unwrap(
        await api.v1.sandboxes({ id }).pause.post(),
        "Failed to pause sandbox",
      );
    },
    onSuccess: () => {
      invalidate();
      toast.success("Sandbox paused");
    },
    onError: (error) => toast.error(error.message),
  });
}

export function useResumeSandbox() {
  const invalidate = useInvalidateSandboxes();
  return useMutation({
    mutationFn: async (id: string) => {
      unwrap(
        await api.v1.sandboxes({ id }).resume.post({}),
        "Failed to resume sandbox",
      );
    },
    onSuccess: () => {
      invalidate();
      toast.success("Sandbox resumed");
    },
    onError: (error) => toast.error(error.message),
  });
}

export function useDestroySandbox() {
  const invalidate = useInvalidateSandboxes();
  return useMutation({
    mutationFn: async (id: string) => {
      unwrap(
        await api.v1.sandboxes({ id }).delete(),
        "Failed to destroy sandbox",
      );
    },
    onSuccess: () => {
      invalidate();
      toast.success("Sandbox destroyed");
    },
    onError: (error) => toast.error(error.message),
  });
}

export function useSnapshotSandbox() {
  const invalidate = useInvalidateSandboxes();
  return useMutation({
    mutationFn: async (id: string) => {
      return unwrap(
        await api.v1.sandboxes({ id }).snapshot.post(),
        "Failed to snapshot sandbox",
      );
    },
    onSuccess: (data) => {
      invalidate();
      toast.success(`Snapshot created${data ? `: ${data.ref}` : ""}`);
    },
    onError: (error) => toast.error(error.message),
  });
}

/** Set the sandbox's display name; an empty `name` clears it. */
export function useRenameSandbox() {
  const invalidate = useInvalidateSandboxes();
  return useMutation({
    mutationFn: async ({ id, name }: { id: string; name: string }) => {
      unwrap(
        await api.v1.sandboxes({ id }).patch({ name: name.trim() || null }),
        "Failed to rename sandbox",
      );
    },
    onSuccess: (_data, { name }) => {
      invalidate();
      toast.success(name.trim() ? "Sandbox renamed" : "Sandbox name cleared");
    },
    onError: (error) => toast.error(error.message),
  });
}

/** Keep a sandbox from being idle-paused until a time, or `null` to
 * stop. */
export function useKeepAwake() {
  const invalidate = useInvalidateSandboxes();
  return useMutation({
    mutationFn: async ({ id, until }: { id: string; until: string | null }) => {
      unwrap(
        await api.v1.sandboxes({ id }).patch({ keepAwakeUntil: until }),
        "Failed to keep sandbox awake",
      );
    },
    onSuccess: (_data, { until }) => {
      invalidate();
      toast.success(
        until ? "Sandbox kept awake" : "Sandbox can sleep when idle again",
      );
    },
    onError: (error) => toast.error(error.message),
  });
}

/**
 * Fork a sandbox: `202` + a `sandbox-create` job whose
 * `metadata.sandboxId` is the copy's id. Resolves to that id so the caller can
 * open the copy while it boots.
 */
export function useForkSandbox() {
  const invalidate = useInvalidateSandboxes();
  return useMutation({
    mutationFn: async (id: string): Promise<string | undefined> => {
      const job = unwrap(
        await api.v1.sandboxes({ id }).fork.post({}),
        "Failed to fork sandbox",
      );
      return job.metadata?.sandboxId;
    },
    onSuccess: () => {
      invalidate();
      toast.success("Forking sandbox…");
    },
    onError: (error) => toast.error(error.message),
  });
}

export function useProcessAction(id: string) {
  const invalidate = useInvalidateSandboxes();
  return useMutation({
    mutationFn: async ({
      name,
      action,
    }: {
      name: string;
      action: "start" | "stop";
    }) => {
      unwrap(
        await api.v1.sandboxes({ id }).processes({ name })({ action }).post(),
        `Failed to ${action} process`,
      );
    },
    onSuccess: (_data, { name, action }) => {
      invalidate();
      toast.success(
        `Process "${name}" ${action === "start" ? "started" : "stopped"}`,
      );
    },
    onError: (error) => toast.error(error.message),
  });
}

export function useAddPort(id: string) {
  const invalidate = useInvalidateSandboxes();
  return useMutation({
    mutationFn: async (body: {
      name: string;
      port: number;
      public?: boolean;
    }) => {
      unwrap(
        await api.v1.sandboxes({ id }).ports.post(body),
        "Failed to add port",
      );
    },
    onSuccess: (_data, { name }) => {
      invalidate();
      toast.success(`Port "${name}" exposed`);
    },
    onError: (error) => toast.error(error.message),
  });
}

/**
 * Spawn a sandbox. The endpoint now answers `202` with a `sandbox-create`
 * JobRecord immediately (the multi-minute boot runs in the background), so the
 * mutation resolves in ~the POST round-trip instead of locking the button for
 * the whole spawn. The returned job carries `metadata.sandboxId` (pre-
 * allocated server-side) — the caller navigates straight to the detail page,
 * which shows the `creating` record and flips to `running` when the job
 * settles (completion toast + list refresh arrive via `useJobEvents`).
 */
export function useSpawnSandbox() {
  const invalidate = useInvalidateSandboxes();
  return useMutation({
    mutationFn: async (request: CreateSandboxRequest) => {
      return unwrap(
        await api.v1.sandboxes.post(request),
        "Failed to spawn sandbox",
      );
    },
    onSuccess: () => {
      // Surface the `creating` row in the list immediately; the job feed
      // handles the completion toast + refresh.
      invalidate();
    },
    onError: (error) => toast.error(error.message),
  });
}
