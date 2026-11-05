import { repoShortName } from "@atelier/spec";
import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, Loader2, ScrollText } from "lucide-react";
import { useState } from "react";
import { jobsListQuery, jobWarnings, latestSetupJob } from "@/api/queries/jobs";
import { JobLogs } from "@/components/job-row";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { cn } from "@/lib/utils";

/**
 * A branch switch's build steps (`sandbox-setup` job): the sandbox booted
 * from the repo's default-branch prebuild, checked the branch out, and now
 * re-runs the prebuild's build steps while the user already works in it.
 * Shown while they run, and after if they left warnings or did not finish;
 * a clean finish needs no card (the toast said so). Live from the jobs feed.
 */
export function BranchSetupSection({ sandboxId }: { sandboxId: string }) {
  const { data: jobs } = useQuery(jobsListQuery());
  const [showLogs, setShowLogs] = useState(false);
  const job = latestSetupJob(jobs, sandboxId);
  if (!job) return null;
  const active = job.status === "queued" || job.status === "running";
  const warnings = jobWarnings(job);
  if (!active && job.status === "succeeded" && warnings.length === 0) {
    return null;
  }
  const branch = job.metadata?.branch ?? "the branch";
  const repo = job.metadata?.repo ? repoShortName(job.metadata.repo) : "";

  return (
    <Card className={active ? "border-info/40" : "border-warning/40"}>
      <CardContent className="space-y-2 p-4 text-sm">
        <div className="flex items-start gap-2">
          {active ? (
            <Loader2 className="mt-0.5 size-4 shrink-0 animate-spin text-info" />
          ) : (
            <AlertTriangle className="mt-0.5 size-4 shrink-0 text-warning" />
          )}
          <div className="min-w-0 flex-1 space-y-1">
            <p
              className={cn(
                "font-medium",
                active ? "text-info" : "text-warning",
              )}
            >
              {active
                ? `Setting up ${branch}`
                : warnings.length > 0
                  ? `${branch} is set up, with warnings`
                  : `The setup of ${branch} did not finish`}
            </p>
            {active ? (
              <p className="text-muted-foreground">
                {repo ? `${repo} is on ${branch}. ` : ""}The prebuild's build
                steps are re-running for it. You can already work in the
                sandbox: dependencies may be out of date until they finish, then
                the dev servers restart.
              </p>
            ) : warnings.length > 0 ? (
              <ul className="list-disc space-y-0.5 pl-4 text-muted-foreground">
                {warnings.map((warning) => (
                  <li key={warning}>{warning}</li>
                ))}
              </ul>
            ) : (
              <p className="text-muted-foreground">
                {job.error ?? "It stopped before the build steps were done."}{" "}
                Dependencies may be out of date.
              </p>
            )}
          </div>
          <Button
            variant="ghost"
            size="sm"
            className="shrink-0"
            aria-expanded={showLogs}
            onClick={() => setShowLogs((v) => !v)}
          >
            <ScrollText />
            Logs
          </Button>
        </div>
        {showLogs ? <JobLogs id={job.id} /> : null}
      </CardContent>
    </Card>
  );
}
