import {
  queryOptions,
  useMutation,
  useQueryClient,
} from "@tanstack/react-query";
import { toast } from "sonner";
import { api } from "@/api/client";
import { errorMessage } from "./error";
import { queryKeys } from "./keys";

/** The job shape, derived from the server's `GET /v1/jobs` response so it
 * always tracks the runtime `JobRecord` without a hand-mirrored type. */
type JobsResponse = NonNullable<
  Awaited<ReturnType<typeof api.v1.jobs.get>>["data"]
>;
export type Job = JobsResponse[number];
export type JobStatus = Job["status"];

/** True only while a job is actually executing (not merely waiting for a
 * concurrency slot). */
export function isJobRunning(job: Job): boolean {
  return job.status === "running";
}

/**
 * The global job queue (GET /v1/jobs) — durable, observable long runtime ops.
 * The `/v1/jobs/events` SSE feed (see `useJobEvents`) owns keeping this cache
 * live, including the fallback poll while the stream is disconnected — so this
 * query deliberately has NO `refetchInterval`: a blind interval refetch racing
 * the SSE merge could overwrite a just-settled job back to `running` (the poll
 * response reflects the pre-settle snapshot), and since the job is already
 * terminal server-side no further event would ever correct it.
 */
export function jobsListQuery() {
  return queryOptions({
    queryKey: queryKeys.jobs.list(),
    queryFn: async () => {
      const { data, error } = await api.v1.jobs.get();
      if (error) throw new Error(errorMessage(error, "Failed to load jobs"));
      return data;
    },
  });
}

/**
 * A job's live log tail (GET /v1/jobs/:id/logs) — build step output for
 * prebuild/toolset jobs. Polls every 2s while the job is active, then stops,
 * mirroring the image builder's log query. In-memory/ephemeral server-side.
 */
export function jobLogsQuery(id: string) {
  return queryOptions({
    queryKey: queryKeys.jobs.logs(id),
    queryFn: async () => {
      const { data, error } = await api.v1.jobs({ id }).logs.get();
      if (error) throw new Error(errorMessage(error, "Failed to load logs"));
      return data;
    },
    refetchInterval: (query) => {
      const status = query.state.data?.status;
      return status === "running" || status === "queued" ? 2000 : false;
    },
  });
}

/** Cancel a running job (POST /v1/jobs/:id/cancel). Best-effort: the row flips
 * to `canceled` immediately; work that ignores the abort drains in the
 * background. */
export function useCancelJob() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const { data, error } = await api.v1.jobs({ id }).cancel.post();
      if (error) throw new Error(errorMessage(error, "Failed to cancel job"));
      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.jobs.all });
    },
    onError: (error) => toast.error(error.message),
  });
}

/** A short, human label for a job kind. */
export function jobKindLabel(kind: Job["kind"]): string {
  switch (kind) {
    case "prebuild":
      return "Prebuild";
    case "toolset-build":
      return "Toolset build";
    case "toolset-capture":
      return "Toolset capture";
    case "image-build":
      return "Image build";
    case "sandbox-create":
      return "Spawn";
    case "sandbox-pause":
      return "Pause";
    case "sandbox-resume":
      return "Resume";
    case "sandbox-snapshot":
      return "Snapshot";
    case "sandbox-destroy":
      return "Destroy";
    default:
      return kind;
  }
}
