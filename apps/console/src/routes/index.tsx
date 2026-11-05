import type { AgentSession, AgentSessionStatus } from "@atelier/spec";
import {
  repoShortName,
  SANDBOX_CHECKOUT_ANNOTATION,
  SANDBOX_IDLE_PAUSED_ANNOTATION,
  type SandboxSummary,
  withCheckout,
} from "@atelier/spec";
import { useQueries, useQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import {
  AlertTriangle,
  Loader2,
  Pause,
  Pencil,
  Play,
  Rocket,
  Trash2,
} from "lucide-react";
import { useState } from "react";
import { jobsListQuery, latestSetupJob } from "@/api/queries/jobs";
import { organizationsListQuery } from "@/api/queries/organizations";
import {
  sandboxDetailQuery,
  sandboxListQuery,
  useDestroySandbox,
  usePauseSandbox,
  useResumeSandbox,
} from "@/api/queries/sandboxes";
import {
  sessionStatusesQuery,
  sessionsListQuery,
  useAbortSession,
  useDeleteSession,
} from "@/api/queries/sessions";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { ForkButton } from "@/components/fork-button";
import { ImmersiveView } from "@/components/immersive-view";
import { KeepAwakeButton } from "@/components/keep-awake-button";
import { RenameSandboxDialog } from "@/components/rename-sandbox-dialog";
import {
  SessionsByRepo,
  SessionsByRepoSkeleton,
} from "@/components/sessions-by-repo";
import { TaskInboxSection } from "@/components/task-inbox/task-inbox-section";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { GithubIcon } from "@/components/ui/github-icon";
import { Skeleton } from "@/components/ui/skeleton";
import { useAgentEvents } from "@/hooks/use-agent-events";
import {
  formatDuration,
  formatRelativeTime,
  msUntil,
  repoBranchLabel,
} from "@/lib/formatters";
import {
  harnessFromAnnotations,
  orgIdFromAnnotations,
  ownerFromAnnotations,
  sandboxNameFromAnnotations,
  sandboxStatusPresentation,
} from "@/lib/sandbox-status";

export const Route = createFileRoute("/")({
  component: MissionControlPage,
});

function MissionControlPage() {
  const {
    data: sandboxes,
    isPending,
    isError,
    error,
  } = useQuery(sandboxListQuery());

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <TaskInboxSection />
      {isPending ? (
        <div className="space-y-2">
          <Skeleton className="h-16 w-full" />
          <Skeleton className="h-16 w-full" />
        </div>
      ) : isError ? (
        <Card className="border-destructive/50">
          <CardHeader>
            <CardTitle>Failed to load sandboxes</CardTitle>
            <CardDescription>{error.message}</CardDescription>
          </CardHeader>
        </Card>
      ) : !sandboxes || sandboxes.length === 0 ? (
        <EmptyState
          icon={Rocket}
          title="Spin up your first agent"
          description="Spawn a sandbox from a prebuild in seconds."
          action={
            <Button asChild>
              <Link to="/spawn">Spawn a sandbox</Link>
            </Button>
          }
        />
      ) : (
        <Fleet sandboxes={sandboxes} />
      )}
    </div>
  );
}

function Fleet({ sandboxes }: { sandboxes: SandboxSummary[] }) {
  const runningIds = sandboxes
    .filter((s) => s.status === "running")
    .map((s) => s.id);
  const fleet = useFleetSessions(runningIds);
  return (
    <>
      <SandboxesSection sandboxes={sandboxes} failedIds={fleet.failedIds} />
      <FleetSessionsSection runningIds={runningIds} fleet={fleet} />
    </>
  );
}

// ── sessions, aggregated across the fleet ───────────────────────────────────

/** Only sandboxes that can plausibly have a live agent session are worth a
 * round-trip — paused/stopped/error sandboxes never do. */
function useFleetSessions(sandboxIds: string[]) {
  const sessionQueries = useQueries({
    queries: sandboxIds.map((id) => sessionsListQuery(id)),
  });
  const statusQueries = useQueries({
    queries: sandboxIds.map((id) => sessionStatusesQuery(id)),
  });

  const isPending = sessionQueries.some((q) => q.isPending);
  // A sandbox whose sessions/statuses endpoint fails would look session-less:
  // report it so its row can show a warning.
  const failedIds = new Set<string>();
  sandboxIds.forEach((id, i) => {
    if (sessionQueries[i]?.isError || statusQueries[i]?.isError)
      failedIds.add(id);
  });
  const sessions: AgentSession[] = sessionQueries.flatMap((q) => q.data ?? []);
  const statuses: Record<string, AgentSessionStatus> = {};
  for (const q of statusQueries) Object.assign(statuses, q.data ?? {});

  return { sessions, statuses, isPending, failedIds };
}

/** An invisible per-sandbox SSE subscriber (hooks can't be called in a
 * dynamic loop, so `FleetSessionsSection` renders one of these per running
 * sandbox). Each invalidates that sandbox's session/status/todo queries live,
 * per plan §1.4/§3.1, instead of relying solely on polling.
 *
 * TODO(perf, per plan §3.1): fine for tens of sandboxes; opens one
 * EventSource per running sandbox, so a large fleet should get a server
 * `GET /sessions/all` aggregate + a single multiplexed SSE stream instead. */
function FleetLiveSubscription({ sandboxId }: { sandboxId: string }) {
  useAgentEvents(sandboxId);
  return null;
}

function FleetSessionsSection({
  runningIds,
  fleet: { sessions, statuses, isPending },
}: {
  runningIds: string[];
  fleet: ReturnType<typeof useFleetSessions>;
}) {
  const [openSandboxId, setOpenSandboxId] = useState<string | null>(null);
  const { data: openSandbox } = useQuery({
    // biome-ignore lint/style/noNonNullAssertion: non-null when `enabled` below.
    ...sandboxDetailQuery(openSandboxId!),
    enabled: openSandboxId !== null,
  });
  const abort = useAbortSession();
  const deleteSession = useDeleteSession();

  if (runningIds.length === 0) return null;

  return (
    <section className="space-y-2">
      {runningIds.map((id) => (
        <FleetLiveSubscription key={id} sandboxId={id} />
      ))}
      <h2 className="text-sm font-medium text-muted-foreground">Sessions</h2>
      {isPending ? (
        <SessionsByRepoSkeleton />
      ) : sessions.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No active agent sessions.
        </p>
      ) : (
        <SessionsByRepo
          sessions={sessions}
          statuses={statuses}
          onAbort={(session) =>
            abort.mutate({
              sandboxId: session.sandboxId,
              sessionId: session.id,
            })
          }
          onDelete={(session) =>
            deleteSession.mutate({
              sandboxId: session.sandboxId,
              sessionId: session.id,
            })
          }
          onOpen={(session) => setOpenSandboxId(session.sandboxId)}
          abortingId={abort.isPending ? abort.variables?.sessionId : undefined}
          deletingId={
            deleteSession.isPending
              ? deleteSession.variables?.sessionId
              : undefined
          }
        />
      )}

      {openSandboxId && openSandbox ? (
        <ImmersiveView
          sandbox={openSandbox}
          onClose={() => setOpenSandboxId(null)}
        />
      ) : null}
    </section>
  );
}

/** Org id → org name, for the fleet's org badges; only orgs the caller
 * belongs to resolve (a sandbox in an org they've since left just shows no
 * badge, never a raw id). */
function useOrgNameById(): Map<string, string> {
  const { data: orgs } = useQuery(organizationsListQuery());
  return new Map((orgs ?? []).map((org) => [org.id, org.name] as const));
}

function SandboxesSection({
  sandboxes,
  failedIds,
}: {
  sandboxes: SandboxSummary[];
  failedIds: ReadonlySet<string>;
}) {
  const orgNameById = useOrgNameById();
  return (
    <section className="space-y-2">
      <h2 className="text-sm font-medium text-muted-foreground">Sandboxes</h2>
      <div className="space-y-2">
        {[...sandboxes]
          // Coerce: some persisted/staging rows carry a non-string createdAt,
          // so guard before localeCompare (a bare `.localeCompare` throws).
          .sort((a, b) =>
            String(b.createdAt ?? "").localeCompare(String(a.createdAt ?? "")),
          )
          .map((sandbox) => (
            <SandboxRow
              key={sandbox.id}
              sandbox={sandbox}
              orgNameById={orgNameById}
              sessionsFailed={failedIds.has(sandbox.id)}
            />
          ))}
      </div>
    </section>
  );
}

/** The repos a sandbox booted with, as one muted line: `owner/name#branch`,
 * comma-separated for a multi-repo prebuild. */
function SandboxRepos({
  repos,
}: {
  repos: NonNullable<SandboxSummary["repos"]>;
}) {
  const label = repos
    .map((repo) => repoBranchLabel(repoShortName(repo.url), repo.branch))
    .join(", ");
  return (
    <span
      className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground"
      title={repos.map((repo) => repo.url).join("\n")}
    >
      <GithubIcon className="size-3 shrink-0" />
      <span className="truncate font-mono">{label}</span>
    </span>
  );
}

/** When an unused running sandbox will be paused, or why it was. */
function IdleHint({ sandbox }: { sandbox: SandboxSummary }) {
  const idle = sandbox.idle;
  if (
    sandbox.status === "paused" &&
    sandbox.annotations?.[SANDBOX_IDLE_PAUSED_ANNOTATION]
  ) {
    return (
      <span className="text-xs text-muted-foreground">· paused when idle</span>
    );
  }
  if (idle?.state === "active" && idle.pausesAt) {
    const left = formatDuration(msUntil(idle.pausesAt));
    return (
      <span className="text-xs text-muted-foreground">
        ·{" "}
        {idle.mode === "observe"
          ? `would idle-pause in ${left}`
          : `idle pause in ${left}`}
      </span>
    );
  }
  if (idle?.state === "due") {
    return <span className="text-xs text-warning">· idle</span>;
  }
  return null;
}

function SandboxRow({
  sandbox,
  orgNameById,
  sessionsFailed,
}: {
  sandbox: SandboxSummary;
  orgNameById: Map<string, string>;
  sessionsFailed: boolean;
}) {
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [renameOpen, setRenameOpen] = useState(false);
  const pause = usePauseSandbox();
  const resume = useResumeSandbox();
  const destroy = useDestroySandbox();
  const status = sandboxStatusPresentation(sandbox.status);
  const harness = harnessFromAnnotations(sandbox.annotations);
  const owner = ownerFromAnnotations(sandbox.annotations);
  const name = sandboxNameFromAnnotations(sandbox.annotations);
  const orgId = orgIdFromAnnotations(sandbox.annotations);
  const orgName = orgId ? orgNameById.get(orgId) : undefined;
  // A switched or cloned repo's setup steps, still running in the sandbox.
  const { data: jobs } = useQuery(jobsListQuery());
  const setup = latestSetupJob(jobs, sandbox.id);
  const settingUp = setup?.status === "running" || setup?.status === "queued";
  const repos = withCheckout(
    sandbox.repos ?? [],
    sandbox.annotations?.[SANDBOX_CHECKOUT_ANNOTATION],
  );

  return (
    <Card>
      <CardContent className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between">
        <Link
          to="/sandboxes/$sandboxId"
          params={{ sandboxId: sandbox.id }}
          className="flex min-w-0 flex-1 flex-col gap-1"
        >
          <span className="flex flex-wrap items-center gap-2 min-w-0">
            {name ? (
              <span className="truncate text-sm font-medium" title={sandbox.id}>
                {name}
              </span>
            ) : (
              <span className="truncate font-mono text-sm">{sandbox.id}</span>
            )}
            <Badge variant={status.variant}>{status.label}</Badge>
            {settingUp ? (
              <Badge
                variant="info"
                className="gap-1"
                title="Its repo's setup steps are running in the sandbox"
              >
                <Loader2 className="size-3 animate-spin" />
                Setting up
              </Badge>
            ) : null}
            {harness ? <Badge variant="outline">{harness}</Badge> : null}
            {owner ? <Badge variant="secondary">@{owner}</Badge> : null}
            {orgName ? <Badge variant="outline">{orgName}</Badge> : null}
            <span className="text-xs text-muted-foreground">
              {formatRelativeTime(sandbox.createdAt)}
            </span>
            <IdleHint sandbox={sandbox} />
            {sessionsFailed ? (
              <span
                role="img"
                aria-label="Could not load this sandbox's sessions"
                title="Could not load this sandbox's sessions"
              >
                <AlertTriangle className="size-3.5 text-warning" />
              </span>
            ) : null}
          </span>
          {repos.length > 0 ? <SandboxRepos repos={repos} /> : null}
        </Link>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="icon"
            onClick={() => setRenameOpen(true)}
            aria-label="Rename sandbox"
          >
            <Pencil />
          </Button>
          {sandbox.status === "running" ? (
            <KeepAwakeButton sandboxId={sandbox.id} size="icon" iconOnly />
          ) : null}
          {sandbox.status === "running" || sandbox.status === "paused" ? (
            <ForkButton sandboxId={sandbox.id} size="icon" iconOnly />
          ) : null}
          {sandbox.status === "running" ? (
            <Button
              variant="outline"
              size="icon"
              disabled={pause.isPending}
              onClick={() => pause.mutate(sandbox.id)}
              aria-label="Pause sandbox"
            >
              {pause.isPending ? (
                <Loader2 className="animate-spin" />
              ) : (
                <Pause />
              )}
            </Button>
          ) : null}
          {sandbox.status === "paused" ? (
            <Button
              variant="outline"
              size="icon"
              disabled={resume.isPending}
              onClick={() => resume.mutate(sandbox.id)}
              aria-label="Resume sandbox"
            >
              {resume.isPending ? (
                <Loader2 className="animate-spin" />
              ) : (
                <Play />
              )}
            </Button>
          ) : null}
          <Button
            variant="outline"
            size="icon"
            disabled={destroy.isPending}
            onClick={() => setConfirmOpen(true)}
            aria-label="Destroy sandbox"
          >
            {destroy.isPending ? (
              <Loader2 className="animate-spin" />
            ) : (
              <Trash2 />
            )}
          </Button>
        </div>
      </CardContent>
      <ConfirmDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        title="Destroy sandbox?"
        description={
          <>
            This permanently deletes{" "}
            <span className="font-mono">{sandbox.id}</span>
            {name ? ` (${name})` : ""}. This cannot be undone.
          </>
        }
        confirmLabel="Destroy"
        onConfirm={() => destroy.mutateAsync(sandbox.id)}
      />
      <RenameSandboxDialog
        sandboxId={sandbox.id}
        currentName={name}
        open={renameOpen}
        onOpenChange={setRenameOpen}
      />
    </Card>
  );
}
