import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { Bot, Radio } from "lucide-react";
import { useState } from "react";
import { sandboxDetailQuery } from "@/api/queries/sandboxes";
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
import { SandboxTasks } from "@/components/task-inbox/sandbox-tasks";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { useAgentEvents } from "@/hooks/use-agent-events";

export const Route = createFileRoute("/sandboxes/$sandboxId/sessions")({
  component: SessionsPage,
});

function SessionsPage() {
  const { sandboxId } = Route.useParams();
  const { connected } = useAgentEvents(sandboxId);
  const { data: sandbox } = useQuery(sandboxDetailQuery(sandboxId));
  const [immersiveOpen, setImmersiveOpen] = useState(false);

  const {
    data: sessions,
    isPending,
    isError,
    error,
  } = useQuery(sessionsListQuery(sandboxId));
  const { data: statuses } = useQuery(sessionStatusesQuery(sandboxId));
  const abort = useAbortSession();
  const deleteSession = useDeleteSession();

  return (
    <div className="mx-auto max-w-5xl space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <Link
          to="/sandboxes/$sandboxId"
          params={{ sandboxId }}
          className="text-sm text-muted-foreground underline"
        >
          ← Sandbox
        </Link>
        <span className="text-muted-foreground">/</span>
        <h1 className="text-lg font-semibold">Sessions</h1>
        <Badge variant={connected ? "success" : "secondary"} aria-live="polite">
          <Radio className="mr-1 size-3" />
          {connected ? "Live" : "Reconnecting"}
        </Badge>
      </div>

      <SandboxTasks sandboxId={sandboxId} />

      <Card>
        <CardHeader>
          <CardTitle>Agent sessions</CardTitle>
        </CardHeader>
        <CardContent>
          {isPending ? (
            <SessionsByRepoSkeleton />
          ) : isError ? (
            <p className="text-sm text-destructive">
              {error instanceof Error ? error.message : "Failed to load"}
            </p>
          ) : !sessions || sessions.length === 0 ? (
            <EmptyState
              icon={Bot}
              title="No agent sessions"
              description="Start a session from the harness UI — it'll show up here once it's running."
            />
          ) : (
            <SessionsByRepo
              sessions={sessions}
              statuses={statuses}
              onAbort={(session) =>
                abort.mutate({ sandboxId, sessionId: session.id })
              }
              onDelete={(session) =>
                deleteSession.mutate({ sandboxId, sessionId: session.id })
              }
              onOpen={() => setImmersiveOpen(true)}
              abortingId={
                abort.isPending ? abort.variables?.sessionId : undefined
              }
              deletingId={
                deleteSession.isPending
                  ? deleteSession.variables?.sessionId
                  : undefined
              }
            />
          )}
        </CardContent>
      </Card>

      {immersiveOpen && sandbox ? (
        <ImmersiveView
          sandbox={sandbox}
          onClose={() => setImmersiveOpen(false)}
        />
      ) : null}
    </div>
  );
}
