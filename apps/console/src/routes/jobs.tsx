import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { ListChecks } from "lucide-react";
import { useState } from "react";
import { type Job, jobsListQuery } from "@/api/queries/jobs";
import { JobRow } from "@/components/job-row";
import { EmptyState } from "@/components/ui/empty-state";
import { NativeSelect } from "@/components/ui/native-select";
import { Skeleton } from "@/components/ui/skeleton";

export const Route = createFileRoute("/jobs")({
  component: JobsPage,
});

const STATUS_FILTERS = [
  "all",
  "running",
  "queued",
  "failed",
  "succeeded",
  "canceled",
] as const;
type StatusFilter = (typeof STATUS_FILTERS)[number];

/** Job history: every recent job with its status, logs and cancel. Kept live
 * by the job feed (`useJobEvents`). */
function JobsPage() {
  const { data: jobs, isPending, isError, error } = useQuery(jobsListQuery());
  const [filter, setFilter] = useState<StatusFilter>("all");
  const visible: Job[] = (jobs ?? []).filter(
    (job) => filter === "all" || job.status === filter,
  );

  return (
    <div className="mx-auto max-w-5xl space-y-4">
      <div className="flex items-center justify-between gap-3">
        <h1 className="text-xl font-semibold">Jobs</h1>
        <NativeSelect
          className="w-40"
          value={filter}
          onChange={(e) => setFilter(e.target.value as StatusFilter)}
          aria-label="Filter by status"
        >
          {STATUS_FILTERS.map((status) => (
            <option key={status} value={status}>
              {status === "all" ? "All statuses" : status}
            </option>
          ))}
        </NativeSelect>
      </div>
      {isPending ? (
        <Skeleton className="h-24 w-full" />
      ) : isError ? (
        <p className="text-sm text-destructive">{error.message}</p>
      ) : visible.length === 0 ? (
        <EmptyState
          icon={ListChecks}
          title="No jobs"
          description="Spawns, prebuilds and image builds show up here."
        />
      ) : (
        <div className="space-y-2">
          {visible.map((job) => (
            <JobRow key={job.id} job={job} />
          ))}
        </div>
      )}
    </div>
  );
}
