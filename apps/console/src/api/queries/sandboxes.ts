import type { SandboxSpec } from "@atelier/spec";
import {
  queryOptions,
  useMutation,
  useQueryClient,
} from "@tanstack/react-query";
import { toast } from "sonner";
import { api } from "@/api/client";
import { errorMessage } from "./error";
import { queryKeys } from "./keys";

// ── queries ──────────────────────────────────────────────────────────────

export function sandboxListQuery() {
  return queryOptions({
    queryKey: queryKeys.sandboxes.list(),
    queryFn: async () => {
      const { data, error } = await api.v1.sandboxes.get();
      if (error)
        throw new Error(errorMessage(error, "Failed to list sandboxes"));
      return data;
    },
    refetchInterval: 10_000,
  });
}

export function sandboxDetailQuery(id: string) {
  return queryOptions({
    queryKey: queryKeys.sandboxes.detail(id),
    queryFn: async () => {
      const { data, error } = await api.v1.sandboxes({ id }).get();
      if (error) throw new Error(errorMessage(error, "Failed to load sandbox"));
      return data;
    },
    refetchInterval: 5_000,
  });
}

/** Only mounted while the log panel is expanded — mount/unmount gates it. */
export function processLogsQuery(id: string, name: string) {
  return queryOptions({
    queryKey: queryKeys.sandboxes.processLogs(id, name),
    queryFn: async () => {
      const { data, error } = await api.v1
        .sandboxes({ id })
        .processes({ name })
        .logs.get();
      if (error)
        throw new Error(errorMessage(error, "Failed to load process logs"));
      return data;
    },
    refetchInterval: 3_000,
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
      const { error } = await api.v1.sandboxes({ id }).pause.post();
      if (error)
        throw new Error(errorMessage(error, "Failed to pause sandbox"));
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
      const { error } = await api.v1.sandboxes({ id }).resume.post({});
      if (error)
        throw new Error(errorMessage(error, "Failed to resume sandbox"));
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
      const { error } = await api.v1.sandboxes({ id }).delete();
      if (error)
        throw new Error(errorMessage(error, "Failed to destroy sandbox"));
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
      const { data, error } = await api.v1.sandboxes({ id }).snapshot.post();
      if (error)
        throw new Error(errorMessage(error, "Failed to snapshot sandbox"));
      return data;
    },
    onSuccess: (data) => {
      invalidate();
      toast.success(`Snapshot created${data ? `: ${data.ref}` : ""}`);
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
      const { error } = await api.v1
        .sandboxes({ id })
        .processes({ name })({ action })
        .post();
      if (error)
        throw new Error(errorMessage(error, `Failed to ${action} process`));
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
      const { error } = await api.v1.sandboxes({ id }).ports.post(body);
      if (error) throw new Error(errorMessage(error, "Failed to add port"));
    },
    onSuccess: (_data, { name }) => {
      invalidate();
      toast.success(`Port "${name}" exposed`);
    },
    onError: (error) => toast.error(error.message),
  });
}

export function useSpawnSandbox() {
  const invalidate = useInvalidateSandboxes();
  return useMutation({
    mutationFn: async (request: SandboxSpec & { toolboxes?: string[] }) => {
      const { data, error } = await api.v1.sandboxes.post(request);
      if (error)
        throw new Error(errorMessage(error, "Failed to create sandbox"));
      return data;
    },
    onSuccess: () => {
      invalidate();
      toast.success("Sandbox created");
    },
    onError: (error) => toast.error(error.message),
  });
}
