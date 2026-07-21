import { useQuery } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import type { Job } from "@/api/queries/jobs";
import { jobsListQuery } from "@/api/queries/jobs";
import { Badge, type BadgeVariant } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

const STATUS_VARIANT: Record<Job["status"], BadgeVariant> = {
  queued: "warning",
  running: "info",
  succeeded: "success",
  failed: "danger",
  canceled: "neutral",
};

const STATUS_LABEL: Record<Job["status"], string> = {
  queued: "Queued",
  running: "Running",
  succeeded: "Done",
  failed: "Failed",
  canceled: "Canceled",
};

/**
 * Presentational status pill for a single job — spinner while running, the
 * error as a tooltip when failed. Shared by the header `JobsIndicator` and the
 * inline `<JobStatus>` so the status→colour mapping lives in exactly one place.
 */
export function JobStatusBadge({
  job,
  className,
}: {
  job: Job;
  className?: string;
}) {
  return (
    <Badge
      variant={STATUS_VARIANT[job.status]}
      className={cn("gap-1", className)}
      title={job.error ?? undefined}
    >
      {job.status === "running" ? (
        <Loader2 className="size-3 animate-spin" />
      ) : null}
      {STATUS_LABEL[job.status]}
    </Badge>
  );
}

/**
 * Inline, self-contained per-row job feedback: drop it next to any resource
 * that a runtime job acts on and it reflects that job's live state, driven by
 * the same SSE-fed jobs cache as the header queue — no props plumbing, no
 * local polling.
 *
 *   <JobStatus kind="toolset-build" target={toolset.name} />
 *   <JobStatus kind="prebuild" target={prebuildLabel} />
 *   <JobStatus id={jobId} />              // exact match if you kept the id
 *
 * Matches the MOST RECENT job for `kind`+`target` (the list is newest-first),
 * or the exact `id` when given. Renders nothing when there's no matching job,
 * or — by default — when the latest one is already settled succeeded/canceled
 * (the row itself reflects success); pass `showSettled` to keep it visible.
 * A `failed` job stays shown (with its error) until a newer run supersedes it.
 */
export function JobStatus({
  kind,
  target,
  id,
  showSettled = false,
  className,
}: {
  kind?: Job["kind"];
  target?: string;
  id?: string;
  showSettled?: boolean;
  className?: string;
}) {
  const { data: jobs } = useQuery(jobsListQuery());
  const job = id
    ? jobs?.find((j) => j.id === id)
    : jobs?.find((j) => j.kind === kind && j.target === target);
  if (!job) return null;
  if (
    !showSettled &&
    (job.status === "succeeded" || job.status === "canceled")
  ) {
    return null;
  }
  return <JobStatusBadge job={job} className={className} />;
}
