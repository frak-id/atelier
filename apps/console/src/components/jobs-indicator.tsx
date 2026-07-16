import { useQuery } from "@tanstack/react-query";
import { Loader2, X } from "lucide-react";
import { useMemo, useState } from "react";
import {
  isJobRunning,
  type Job,
  jobKindLabel,
  jobsListQuery,
  useCancelJob,
} from "@/api/queries/jobs";
import { Badge, type BadgeVariant } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { StatusDot } from "@/components/ui/status-dot";
import { formatRelativeTime } from "@/lib/formatters";

/**
 * Header widget for the global job queue: a status-aware button that surfaces
 * what's happening across the app right now — running/queued counts while work
 * is in flight, and a sticky "failed" affordance that persists until the user
 * opens the queue (so a background failure whose toast they missed is never
 * silently lost). Opening it lists the jobs (active + failures by default,
 * with a "show all" toggle) with a cancel action for still-queued ones.
 * Kept live by the `/v1/jobs/events` SSE feed (`useJobEvents`, at the root).
 */
export function JobsIndicator() {
  const [open, setOpen] = useState(false);
  const [showAll, setShowAll] = useState(false);
  // Failure ids the user has already seen (dialog opened while they were
  // failed) — so the sticky red affordance clears once acknowledged.
  const [acked, setAcked] = useState<ReadonlySet<string>>(new Set());
  const { data: jobs } = useQuery(jobsListQuery());

  const running = jobs?.filter(isJobRunning).length ?? 0;
  const queued = jobs?.filter((j) => j.status === "queued").length ?? 0;
  const unackedFailed =
    jobs?.filter((j) => j.status === "failed" && !acked.has(j.id)).length ?? 0;

  const visible = useMemo(() => {
    if (!jobs) return [];
    if (showAll) return jobs;
    return jobs.filter(
      (j) =>
        j.status === "running" ||
        j.status === "queued" ||
        j.status === "failed",
    );
  }, [jobs, showAll]);

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
      <Dialog open={open} onOpenChange={handleOpenChange}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Job queue</DialogTitle>
          </DialogHeader>
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
          <div className="max-h-[60vh] space-y-2 overflow-y-auto">
            {visible.length === 0 ? (
              <p className="py-6 text-center text-sm text-muted-foreground">
                {showAll ? "No jobs yet." : "Nothing active."}
              </p>
            ) : (
              visible.map((job) => <JobRow key={job.id} job={job} />)
            )}
          </div>
        </DialogContent>
      </Dialog>
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

const STATUS_VARIANT: Record<Job["status"], BadgeVariant> = {
  queued: "warning",
  running: "info",
  succeeded: "success",
  failed: "danger",
  canceled: "neutral",
};

function JobRow({ job }: { job: Job }) {
  const cancel = useCancelJob();
  return (
    <div className="flex items-center gap-3 rounded-md border p-2.5">
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
      <Badge variant={STATUS_VARIANT[job.status]} className="shrink-0">
        {job.status}
      </Badge>
      {job.status === "queued" ? (
        <Button
          variant="ghost"
          size="icon"
          className="shrink-0"
          disabled={cancel.isPending}
          onClick={() => cancel.mutate(job.id)}
          title="Cancel queued job"
        >
          <X className="size-4" />
        </Button>
      ) : null}
    </div>
  );
}
