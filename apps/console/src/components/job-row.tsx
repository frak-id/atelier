import { useQuery } from "@tanstack/react-query";
import { Check, ScrollText, X } from "lucide-react";
import { useState } from "react";
import {
  type Job,
  jobKindLabel,
  jobLogsQuery,
  useCancelJob,
} from "@/api/queries/jobs";
import { JobStatusBadge } from "@/components/job-status";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { formatRelativeTime } from "@/lib/formatters";

/** Pooled build kinds: they run through the concurrency pool, capture step
 * output into the job log, and are the only *running* jobs the server lets you
 * cancel (queued jobs of any kind, and these while running). Tracked kinds
 * (sandbox-*, image-build) are unpooled/awaited and not cancellable running. */
const POOLED_BUILD_KINDS = new Set<Job["kind"]>([
  "prebuild",
  "toolset-build",
  "toolset-capture",
  "toolbox-refresh",
]);

export function JobRow({
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
