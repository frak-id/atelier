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
 * A repo prepared at boot, then set up in the background (`sandbox-setup`
 * job): either switched (the sandbox booted another branch's prebuild,
 * checked its branch out, and re-runs the prebuild's build steps) or cloned
 * (no prebuild: the bare image cloned it and runs its setup steps), while
 * the user already works in it. Shown while they run, and after if they
 * left warnings or did not finish; a clean finish needs no card (the toast
 * said so). Live from the jobs feed.
 */
export function RepoSetupSection({ sandboxId }: { sandboxId: string }) {
  const { data: jobs } = useQuery(jobsListQuery());
  const [showLogs, setShowLogs] = useState(false);
  const job = latestSetupJob(jobs, sandboxId);
  if (!job) return null;
  const active = job.status === "queued" || job.status === "running";
  const warnings = jobWarnings(job);
  if (!active && job.status === "succeeded" && warnings.length === 0) {
    return null;
  }
  const cloned = job.metadata?.mode === "clone";
  const repo = job.metadata?.repo ? repoShortName(job.metadata.repo) : "";
  const branch = job.metadata?.branch;
  // What is being set up: the branch of a switch, the repo of a clone.
  const subject = cloned
    ? repo || "the repo"
    : (branch ?? job.target ?? "the branch");

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
                ? `Setting up ${subject}`
                : warnings.length > 0
                  ? `${subject} is set up, with warnings`
                  : `The setup of ${subject} did not finish`}
            </p>
            {active ? (
              <p className="text-muted-foreground">
                {cloned
                  ? `${repo || "The repo"} is cloned${branch ? ` on ${branch}` : ""}, and its setup steps are running. `
                  : `${repo ? `${repo} is on ${branch}. ` : ""}The prebuild's build steps are re-running for it. `}
                You can already work in the sandbox: dependencies may be missing
                or out of date until they finish
                {cloned ? "." : ", then the dev servers restart."}
              </p>
            ) : warnings.length > 0 ? (
              <ul className="list-disc space-y-0.5 pl-4 text-muted-foreground">
                {warnings.map((warning) => (
                  <li key={warning}>{warning}</li>
                ))}
              </ul>
            ) : (
              <p className="text-muted-foreground">
                {job.error ?? "It stopped before the steps were done."}{" "}
                Dependencies may be missing or out of date.
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
