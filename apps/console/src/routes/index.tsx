import type { SandboxSummary } from "@atelier/spec";
import type { AgentSession, AgentSessionStatus } from "@frak/atelier-shared";
import { useQueries, useQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { Loader2, Pause, Play, Rocket, Trash2 } from "lucide-react";
import { useState } from "react";
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
import { ImmersiveView } from "@/components/immersive-view";
import {
  SessionsByRepo,
  SessionsByRepoSkeleton,
} from "@/components/sessions-by-repo";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { EmptyState } from "@/components/ui/empty-state";
import { Skeleton } from "@/components/ui/skeleton";
import { StatusDot } from "@/components/ui/status-dot";
import { useAgentEvents } from "@/hooks/use-agent-events";
import { formatRelativeTime } from "@/lib/formatters";
import {
  harnessFromAnnotations,
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
          description="Pick a template to get a working sandbox in seconds."
          action={
            <Button asChild>
              <Link to="/spawn">Spawn a sandbox</Link>
            </Button>
          }
        />
      ) : (
        <>
          <FleetSessionsSection sandboxes={sandboxes} />
          <SandboxesSection sandboxes={sandboxes} />
        </>
      )}
    </div>
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
  // TODO(review): per-sandbox query errors are swallowed here (`q.data ?? []`),
  // so a sandbox whose sessions endpoint fails silently appears session-less.
  // Surface a per-sandbox error indicator once the server aggregate lands.
  const sessions: AgentSession[] = sessionQueries.flatMap((q) => q.data ?? []);
  const statuses: Record<string, AgentSessionStatus> = {};
  for (const q of statusQueries) Object.assign(statuses, q.data ?? {});

  return { sessions, statuses, isPending };
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

function FleetSessionsSection({ sandboxes }: { sandboxes: SandboxSummary[] }) {
  const runningIds = sandboxes
    .filter((s) => s.status === "running")
    .map((s) => s.id);
  const { sessions, statuses, isPending } = useFleetSessions(runningIds);
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

function SandboxesSection({ sandboxes }: { sandboxes: SandboxSummary[] }) {
  return (
    <section className="space-y-2">
      <h2 className="text-sm font-medium text-muted-foreground">Sandboxes</h2>
      <div className="space-y-2">
        {[...sandboxes]
          .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
          .map((sandbox) => (
            <SandboxRow key={sandbox.id} sandbox={sandbox} />
          ))}
      </div>
    </section>
  );
}

function SandboxRow({ sandbox }: { sandbox: SandboxSummary }) {
  const [confirmOpen, setConfirmOpen] = useState(false);
  const pause = usePauseSandbox();
  const resume = useResumeSandbox();
  const destroy = useDestroySandbox();
  const status = sandboxStatusPresentation(sandbox.status);
  const harness = harnessFromAnnotations(sandbox.annotations);
  const { data: sessions } = useQuery({
    ...sessionsListQuery(sandbox.id),
    enabled: sandbox.status === "running",
  });
  const sessionCount = sessions?.length ?? 0;

  return (
    <Card>
      <CardContent className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between">
        <Link
          to="/sandboxes/$sandboxId"
          params={{ sandboxId: sandbox.id }}
          className="flex flex-1 flex-wrap items-center gap-2 min-w-0"
        >
          <span className="truncate font-mono text-sm">{sandbox.id}</span>
          <Badge variant={status.variant}>{status.label}</Badge>
          {harness ? <Badge variant="outline">{harness}</Badge> : null}
          {sandbox.status === "running" ? (
            <span className="flex items-center gap-1 text-xs text-muted-foreground">
              <StatusDot variant={sessionCount > 0 ? "info" : "neutral"} />
              {sessionCount > 0
                ? `${sessionCount} session${sessionCount === 1 ? "" : "s"}`
                : "no session"}
            </span>
          ) : null}
          <span className="text-xs text-muted-foreground">
            {formatRelativeTime(sandbox.createdAt)}
          </span>
        </Link>
        <div className="flex items-center gap-2">
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
      <Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Destroy sandbox?</DialogTitle>
            <DialogDescription>
              This permanently deletes{" "}
              <span className="font-mono">{sandbox.id}</span>. This cannot be
              undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmOpen(false)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              disabled={destroy.isPending}
              onClick={() => {
                destroy.mutate(sandbox.id);
                setConfirmOpen(false);
              }}
            >
              Destroy
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
