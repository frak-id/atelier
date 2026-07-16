import { type QueryClient, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import { toast } from "sonner";
import { type Job, jobKindLabel } from "@/api/queries/jobs";
import { queryKeys } from "@/api/queries/keys";
import { httpUrl, isCrossOrigin } from "@/lib/api-base";

/**
 * Subscribe to the global job queue's SSE feed (`/v1/jobs/events`) once, at
 * the app root, and fan each event out into cache updates:
 *  - merge the job into the `jobs.list` cache (so the queue indicator is live
 *    without polling);
 *  - when a job we witnessed *running/queued* settles, toast the outcome (for
 *    the async build jobs) and invalidate the domain list it produced.
 *
 * Robustness (the two failure modes reviews flagged):
 *  - RECONNECT GAPS: the server only replays *non-terminal* jobs to a new
 *    subscriber, so a transition that lands during a disconnect is never
 *    re-sent. On every reconnect we refetch the list and reconcile — any id we
 *    still think is in-flight but is now terminal gets its missed settle
 *    synthesized (toast + invalidate).
 *  - POLL/SSE RACE: we never poll while the stream is connected (a blind
 *    interval refetch could overwrite a just-settled job). We only poll as a
 *    fallback *while disconnected*, when SSE isn't concurrently writing.
 */
export function useJobEvents(enabled = true): void {
  const queryClient = useQueryClient();
  // In-flight jobs we've witnessed this session — the guard that stops the
  // connect-time replay from re-toasting history, and the set we reconcile
  // against on reconnect. A ref so it survives re-renders + StrictMode's
  // dev double-mount (the effect cleanup closes each EventSource cleanly).
  const seenActive = useRef(new Set<string>());

  useEffect(() => {
    if (!enabled) return;
    let hasConnected = false;
    let pollTimer: ReturnType<typeof setInterval> | undefined;

    const stopPolling = () => {
      if (pollTimer) clearInterval(pollTimer);
      pollTimer = undefined;
    };
    const refetch = () =>
      queryClient.refetchQueries({ queryKey: queryKeys.jobs.list() });

    const source = new EventSource(httpUrl("/v1/jobs/events"), {
      withCredentials: isCrossOrigin,
    });

    source.addEventListener("open", () => {
      stopPolling();
      // A reconnect (not the first open) may have missed settle transitions —
      // refetch and synthesize them from the fresh list.
      if (hasConnected) void refetch().then(() => reconcileMissed());
      hasConnected = true;
    });

    source.addEventListener("error", () => {
      // EventSource auto-retries; poll as a fallback until it reconnects.
      // Safe from the poll/SSE race because the stream isn't writing now.
      if (!pollTimer) pollTimer = setInterval(refetch, 5000);
    });

    source.addEventListener("job", (event) => {
      let job: Job;
      try {
        job = JSON.parse(event.data) as Job;
      } catch {
        return;
      }
      queryClient.setQueryData<Job[]>(queryKeys.jobs.list(), (prev) =>
        mergeJob(prev, job),
      );
      if (job.status === "queued" || job.status === "running") {
        seenActive.current.add(job.id);
        return;
      }
      // Settled. Only react to transitions we actually witnessed — skip the
      // historical rows the server replays on (re)connect.
      if (!seenActive.current.delete(job.id)) return;
      onJobSettled(queryClient, job);
    });

    // Reconcile the witnessed-active set against the freshly-fetched list:
    // any id now terminal (or gone) settled during a gap — replay its effect.
    function reconcileMissed() {
      const list = queryClient.getQueryData<Job[]>(queryKeys.jobs.list());
      if (!list) return;
      const byId = new Map(list.map((j) => [j.id, j]));
      for (const id of [...seenActive.current]) {
        const job = byId.get(id);
        if (job && (job.status === "queued" || job.status === "running"))
          continue;
        seenActive.current.delete(id);
        if (job) onJobSettled(queryClient, job);
      }
    }

    return () => {
      stopPolling();
      source.close();
    };
  }, [queryClient, enabled]);
}

/** Upsert `job` into the newest-first list cache by id. */
function mergeJob(prev: Job[] | undefined, job: Job): Job[] {
  if (!prev) return [job];
  const idx = prev.findIndex((j) => j.id === job.id);
  if (idx === -1) return [job, ...prev];
  const next = prev.slice();
  next[idx] = job;
  return next;
}

function onJobSettled(queryClient: QueryClient, job: Job): void {
  if (job.status === "succeeded") invalidateForKind(queryClient, job);
  // Lifecycle ops (`sandbox-*`) are awaited by their route, so their own
  // mutation already toasts the outcome — don't double up. Only the async
  // (dispatch) build jobs need a completion toast from the feed.
  if (job.kind.startsWith("sandbox-")) return;
  const kindLabel = jobKindLabel(job.kind);
  const description = job.error ?? job.target ?? undefined;
  if (job.status === "succeeded") {
    toast.success(`${kindLabel} done`, { description });
  } else if (job.status === "canceled") {
    toast(`${kindLabel} canceled`, { description });
  } else {
    toast.error(`${kindLabel} failed`, { description });
  }
}

function invalidateForKind(queryClient: QueryClient, job: Job): void {
  switch (job.kind) {
    case "prebuild":
      queryClient.invalidateQueries({ queryKey: queryKeys.prebuilds.all });
      break;
    case "toolset-build":
      queryClient.invalidateQueries({ queryKey: queryKeys.toolsets.all });
      break;
    case "toolset-capture":
      // A capture creates a runtime toolset AND (for the toolbox flow) a
      // version row — refresh both.
      queryClient.invalidateQueries({ queryKey: queryKeys.toolsets.all });
      queryClient.invalidateQueries({
        queryKey: queryKeys.toolboxVersions.all,
      });
      break;
    case "sandbox-create":
    case "sandbox-pause":
    case "sandbox-resume":
    case "sandbox-snapshot":
    case "sandbox-destroy":
      // Lifecycle ops are awaited by their route (the mutation's own
      // onSuccess already refreshes), so this is a belt-and-suspenders
      // refresh of the sandbox list for any other watcher.
      queryClient.invalidateQueries({ queryKey: queryKeys.sandboxes.all });
      break;
  }
}
