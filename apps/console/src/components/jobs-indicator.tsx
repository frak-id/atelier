import { useQuery } from "@tanstack/react-query";
import { Check, Loader2, ScrollText, X } from "lucide-react";
import { useMemo, useState } from "react";
import {
  isJobRunning,
  type Job,
  jobKindLabel,
  jobLogsQuery,
  jobsListQuery,
  useCancelJob,
} from "@/api/queries/jobs";
import { JobStatusBadge } from "@/components/job-status";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { StatusDot } from "@/components/ui/status-dot";
import { formatRelativeTime } from "@/lib/formatters";

/**
 * Header widget for the global job queue: a status-aware button that surfaces
 * what's happening across the app right now — running/queued counts while work
 * is in flight, and a sticky "failed" affordance that persists until the user
 * opens the queue (so a background failure whose toast they missed is never
 * silently lost). Clicking it opens a right-hand sidebar listing the jobs
 * (active + failures by default, with a "show all" toggle) with a cancel
 * action. Kept live by the `/v1/jobs/events` SSE feed (`useJobEvents`).
 */
export function JobsIndicator() {
  const [open, setOpen] = useState(false);
  const [showAll, setShowAll] = useState(false);
  // Failure ids the user has already seen (dialog opened while they were
  // failed) — so the sticky red affordance clears once acknowledged.
  const [acked, setAcked] = useState<ReadonlySet<string>>(new Set());
  // Failure ids the user has explicitly dismissed — frontend-only (the row
  // stays in the DB): dropped from the default list and the failed count, but
  // still reachable under "Show all".
  const [dismissed, setDismissed] = useState<ReadonlySet<string>>(new Set());
  const { data: jobs } = useQuery(jobsListQuery());

  const running = jobs?.filter(isJobRunning).length ?? 0;
  const queued = jobs?.filter((j) => j.status === "queued").length ?? 0;
  const unackedFailed =
    jobs?.filter(
      (j) => j.status === "failed" && !acked.has(j.id) && !dismissed.has(j.id),
    ).length ?? 0;

  const visible = useMemo(() => {
    if (!jobs) return [];
    if (showAll) return jobs;
    return jobs.filter(
      (j) =>
        j.status === "running" ||
        j.status === "queued" ||
        (j.status === "failed" && !dismissed.has(j.id)),
    );
  }, [jobs, showAll, dismissed]);

  const dismiss = (id: string) =>
    setDismissed((prev) => new Set(prev).add(id));

  function handleOpenChange(next: boolean) {
    setOpen(next);
    // Acknowledge current failures on open so the sticky badge clears.
    if (next && jobs)
      setAcked(
        new Set(jobs.filter((j) => j.status === "failed").map((j) => j.id)),
      );
  }

  // Nothing to show and never any jobs → stay out of the way entirely.
  if (!open && (jobs?.length ?? 0) === 0) return null;

  return (
    <>
      <Button
        variant="ghost"
        size="sm"
        onClick={() => handleOpenChange(true)}
        title="Job queue"
        className="gap-2"
      >
        {running > 0 ? (
          <Loader2 className="size-4 animate-spin" />
        ) : (
          <StatusDot
            variant={
              unackedFailed > 0 ? "danger" : queued > 0 ? "warning" : "neutral"
            }
          />
        )}
        <span className="text-sm">
          {indicatorLabel(running, queued, unackedFailed)}
        </span>
      </Button>
      <Sheet open={open} onOpenChange={handleOpenChange}>
        <SheetContent side="right" className="gap-3">
          <SheetHeader>
            <SheetTitle>Job queue</SheetTitle>
          </SheetHeader>
          <div className="flex items-center justify-between">
            <p className="text-sm text-muted-foreground">
              {running} running · {queued} queued
            </p>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setShowAll((v) => !v)}
            >
              {showAll ? "Show active" : "Show all"}
            </Button>
          </div>
          <div className="-mr-2 flex-1 space-y-2 overflow-y-auto pr-2">
            {visible.length === 0 ? (
              <p className="py-6 text-center text-sm text-muted-foreground">
                {showAll ? "No jobs yet." : "Nothing active."}
              </p>
            ) : (
              visible.map((job) => (
                <JobRow
                  key={job.id}
                  job={job}
                  onDismiss={
                    job.status === "failed" && !dismissed.has(job.id)
                      ? () => dismiss(job.id)
                      : undefined
                  }
                />
              ))
            )}
          </div>
        </SheetContent>
      </Sheet>
    </>
  );
}

function indicatorLabel(
  running: number,
  queued: number,
  failed: number,
): string {
  if (running > 0)
    return `${running} running${queued > 0 ? ` · ${queued} queued` : ""}`;
  if (failed > 0) return `${failed} failed`;
  if (queued > 0) return `${queued} queued`;
  return "Jobs";
}

/** Pooled build kinds: they run through the concurrency pool, capture step
 * output into the job log, and are the only *running* jobs the server lets you
 * cancel (queued jobs of any kind, and these while running). Tracked kinds
 * (sandbox-*, image-build) are unpooled/awaited and not cancellable running. */
const POOLED_BUILD_KINDS = new Set<Job["kind"]>([
  "prebuild",
  "toolset-build",
  "toolset-capture",
]);

function JobRow({
  job,
  onDismiss,
}: {
  job: Job;
  /** Present only for a dismissable failure — hides this error from the
   * default list (frontend-only; the row stays under "Show all"). */
  onDismiss?: () => void;
}) {
  const cancel = useCancelJob();
  const [showLogs, setShowLogs] = useState(false);
  const cancelable =
    job.status === "queued" ||
    (job.status === "running" && POOLED_BUILD_KINDS.has(job.kind));
  const hasLogs = POOLED_BUILD_KINDS.has(job.kind);
  return (
    <div className="rounded-md border p-2.5">
      <div className="flex items-center gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate text-sm font-medium">
              {job.target ?? jobKindLabel(job.kind)}
            </span>
            <Badge variant="neutral" className="shrink-0">
              {jobKindLabel(job.kind)}
            </Badge>
          </div>
          <p className="mt-0.5 truncate text-xs text-muted-foreground">
            {job.error ? (
              <span className="text-danger" title={job.error}>
                {job.error}
              </span>
            ) : (
              formatRelativeTime(job.createdAt)
            )}
          </p>
        </div>
        <JobStatusBadge job={job} className="shrink-0" />
        {hasLogs ? (
          <Button
            variant="ghost"
            size="icon"
            className="shrink-0"
            onClick={() => setShowLogs((v) => !v)}
            title="Logs"
          >
            <ScrollText className="size-4" />
          </Button>
        ) : null}
        {cancelable ? (
          <Button
            variant="ghost"
            size="icon"
            className="shrink-0"
            disabled={cancel.isPending}
            onClick={() => cancel.mutate(job.id)}
            title={job.status === "queued" ? "Cancel queued job" : "Cancel job"}
          >
            <X className="size-4" />
          </Button>
        ) : onDismiss ? (
          <Button
            variant="ghost"
            size="icon"
            className="shrink-0"
            onClick={onDismiss}
            title="Dismiss error"
          >
            <Check className="size-4" />
          </Button>
        ) : null}
      </div>
      {hasLogs && showLogs ? <JobLogs id={job.id} /> : null}
    </div>
  );
}

function JobLogs({ id }: { id: string }) {
  const { data } = useQuery(jobLogsQuery(id));
  const log = data?.log?.trim();
  return (
    <pre className="mt-2 max-h-56 overflow-auto whitespace-pre-wrap rounded bg-muted p-2 font-mono text-xs text-muted-foreground">
      {log ? log : "No output yet."}
    </pre>
  );
}
