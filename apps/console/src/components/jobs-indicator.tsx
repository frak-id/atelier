import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Loader2 } from "lucide-react";
import { useMemo, useState } from "react";
import { isJobRunning, jobsListQuery } from "@/api/queries/jobs";
import { JobRow } from "@/components/job-row";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { StatusDot } from "@/components/ui/status-dot";

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

  const dismiss = (id: string) => setDismissed((prev) => new Set(prev).add(id));

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
            <div className="flex items-center">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setShowAll((v) => !v)}
              >
                {showAll ? "Show active" : "Show all"}
              </Button>
              <Button asChild variant="ghost" size="sm">
                <Link to="/jobs" onClick={() => setOpen(false)}>
                  History
                </Link>
              </Button>
            </div>
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
