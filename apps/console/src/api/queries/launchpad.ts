/**
 * Launchpad queries (docs/proposals/launchpad.md): the catalog + workspaces a
 * non-technical user sees, and the starter authoring a dev team does.
 *
 * Toasts on the consumer side use plain words ("Your workspace is asleep"),
 * never runtime vocabulary (pause/resume/sandbox).
 */
import type { LaunchRequest, StarterInput, StarterPatch } from "@atelier/spec";
import {
  queryOptions,
  useMutation,
  useQueryClient,
} from "@tanstack/react-query";
import { toast } from "sonner";
import { api } from "@/api/client";
import { errorMessage } from "./error";
import { queryKeys } from "./keys";

type Data<T> = NonNullable<Awaited<T> extends { data: infer D } ? D : never>;

export type CatalogStarter = Data<
  ReturnType<typeof api.api.launchpad.catalog.get>
>[number];
export type Workspace = Data<
  ReturnType<typeof api.api.launchpad.workspaces.get>
>[number];
export type WorkspaceDetail = Data<
  ReturnType<ReturnType<typeof api.api.launchpad.workspaces>["get"]>
>;
export type WorkspacePhase = Workspace["phase"];
export type StarterRecord = Data<
  ReturnType<typeof api.api.launchpad.starters.get>
>[number];

/** Phases that move on their own: poll fast while any is showing. */
function isTransient(phase: WorkspacePhase): boolean {
  return phase === "preparing" || phase === "starting";
}

// ── consumer ─────────────────────────────────────────────────────────────

export function catalogQuery() {
  return queryOptions({
    queryKey: queryKeys.launchpad.catalog(),
    queryFn: async () => {
      const { data, error } = await api.api.launchpad.catalog.get();
      if (error)
        throw new Error(errorMessage(error, "Couldn't load the Launchpad"));
      return data;
    },
    staleTime: 30_000,
  });
}

export function workspacesQuery() {
  return queryOptions({
    queryKey: queryKeys.launchpad.workspaces(),
    queryFn: async () => {
      const { data, error } = await api.api.launchpad.workspaces.get();
      if (error)
        throw new Error(errorMessage(error, "Couldn't load your workspaces"));
      return data;
    },
    refetchInterval: (query) =>
      query.state.data?.some((w) => isTransient(w.phase)) ? 3_000 : 15_000,
  });
}

export function workspaceQuery(id: string) {
  return queryOptions({
    queryKey: queryKeys.launchpad.workspace(id),
    queryFn: async () => {
      const { data, error } = await api.api.launchpad.workspaces({ id }).get();
      if (error) {
        const err = new Error(
          errorMessage(error, "Couldn't load this workspace"),
        ) as Error & { status?: number };
        err.status = error.status;
        throw err;
      }
      return data;
    },
    retry: (count, err) =>
      (err as { status?: number })?.status !== 404 && count < 2,
    // Fast while booting or while a service is still coming up (readiness
    // gates the embedded view), calm once everything is ready.
    refetchInterval: (query) => {
      const data = query.state.data;
      if (!data) return 5_000;
      if (isTransient(data.phase)) return 3_000;
      const warming =
        data.phase === "ready" &&
        data.services.some((s) => s.processes && s.ready !== true);
      return warming ? 3_000 : 15_000;
    },
  });
}

function useInvalidateLaunchpad() {
  const queryClient = useQueryClient();
  return () =>
    queryClient.invalidateQueries({ queryKey: queryKeys.launchpad.all });
}

export function useLaunchStarter() {
  const invalidate = useInvalidateLaunchpad();
  return useMutation({
    mutationFn: async ({
      starterId,
      request,
    }: {
      starterId: string;
      request: LaunchRequest;
    }) => {
      const { data, error } = await api.api.launchpad
        .starters({ id: starterId })
        .launch.post(request);
      if (error)
        throw new Error(errorMessage(error, "Couldn't start the workspace"));
      return data;
    },
    onSuccess: () => invalidate(),
    onError: (error) => toast.error(error.message),
  });
}

export function useUpdateWorkspace() {
  const invalidate = useInvalidateLaunchpad();
  return useMutation({
    mutationFn: async ({
      id,
      patch,
    }: {
      id: string;
      patch: { title?: string; description?: string };
    }) => {
      const { data, error } = await api.api.launchpad
        .workspaces({ id })
        .patch(patch);
      if (error) throw new Error(errorMessage(error, "Couldn't save"));
      return data;
    },
    onSuccess: () => invalidate(),
    onError: (error) => toast.error(error.message),
  });
}

type WorkspaceAction = "sleep" | "wake" | "retry";

const ACTION_COPY: Record<WorkspaceAction, { ok: string; fail: string }> = {
  sleep: {
    ok: "Your workspace is asleep. Wake it up any time.",
    fail: "Couldn't put the workspace to sleep",
  },
  wake: { ok: "Waking up your workspace…", fail: "Couldn't wake it up" },
  retry: { ok: "Trying again…", fail: "Couldn't try again" },
};

export function useWorkspaceAction() {
  const invalidate = useInvalidateLaunchpad();
  return useMutation({
    mutationFn: async ({
      id,
      action,
    }: {
      id: string;
      action: WorkspaceAction;
    }) => {
      const ws = api.api.launchpad.workspaces({ id });
      const { error } =
        action === "sleep"
          ? await ws.sleep.post()
          : action === "wake"
            ? await ws.wake.post()
            : await ws.retry.post();
      if (error) throw new Error(errorMessage(error, ACTION_COPY[action].fail));
    },
    onSuccess: (_data, { action }) => {
      invalidate();
      toast.success(ACTION_COPY[action].ok);
    },
    onError: (error) => toast.error(error.message),
  });
}

export function useDeleteWorkspace() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const { error } = await api.api.launchpad.workspaces({ id }).delete();
      if (error) throw new Error(errorMessage(error, "Couldn't delete it"));
    },
    onSuccess: (_data, id) => {
      queryClient.removeQueries({
        queryKey: queryKeys.launchpad.workspace(id),
      });
      queryClient.invalidateQueries({
        queryKey: queryKeys.launchpad.workspaces(),
      });
      toast.success("Workspace deleted");
    },
    onError: (error) => toast.error(error.message),
  });
}

/**
 * Start a service's processes without the developer console's per-process
 * toasts: the tile itself shows "Starting…" and flips to the embedded view
 * once the workspace poll reports it ready.
 */
export function useStartServiceProcesses(workspaceId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (names: string[]) => {
      await Promise.all(
        names.map(async (name) => {
          const { error } = await api.v1
            .sandboxes({ id: workspaceId })
            .processes({ name })({ action: "start" })
            .post();
          if (error)
            throw new Error(errorMessage(error, "This tool didn't start"));
        }),
      );
    },
    onSettled: () =>
      queryClient.invalidateQueries({
        queryKey: queryKeys.launchpad.workspace(workspaceId),
      }),
    onError: (error) => toast.error(error.message),
  });
}

// ── authoring ────────────────────────────────────────────────────────────

/** `owner` is the `?owner=` scope: `user` (default) or `org:<id>`. */
export function startersQuery(owner?: string) {
  return queryOptions({
    queryKey: queryKeys.launchpad.starters(owner),
    queryFn: async () => {
      const { data, error } = await api.api.launchpad.starters.get({
        query: owner ? { owner } : {},
      });
      if (error)
        throw new Error(errorMessage(error, "Failed to load starters"));
      return data;
    },
    staleTime: 30_000,
  });
}

export function useCreateStarter() {
  const invalidate = useInvalidateLaunchpad();
  return useMutation({
    mutationFn: async ({
      input,
      owner,
    }: {
      input: StarterInput;
      owner?: string;
    }) => {
      const { data, error } = await api.api.launchpad.starters.post(input, {
        query: owner ? { owner } : {},
      });
      if (error)
        throw new Error(errorMessage(error, "Failed to create starter"));
      return data;
    },
    onSuccess: () => {
      invalidate();
      toast.success("Starter saved");
    },
    onError: (error) => toast.error(error.message),
  });
}

export function useUpdateStarter() {
  const invalidate = useInvalidateLaunchpad();
  return useMutation({
    mutationFn: async ({ id, patch }: { id: string; patch: StarterPatch }) => {
      const { data, error } = await api.api.launchpad
        .starters({ id })
        .patch(patch);
      if (error)
        throw new Error(errorMessage(error, "Failed to update starter"));
      return data;
    },
    onSuccess: () => {
      invalidate();
      toast.success("Starter saved");
    },
    onError: (error) => toast.error(error.message),
  });
}

export function useDeleteStarter() {
  const invalidate = useInvalidateLaunchpad();
  return useMutation({
    mutationFn: async (id: string) => {
      const { error } = await api.api.launchpad.starters({ id }).delete();
      if (error)
        throw new Error(errorMessage(error, "Failed to delete starter"));
    },
    onSuccess: () => {
      invalidate();
      toast.success("Starter deleted");
    },
    onError: (error) => toast.error(error.message),
  });
}
