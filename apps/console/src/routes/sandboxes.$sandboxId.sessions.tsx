import type {
  AgentPermissionRequest,
  AgentQuestionRequest,
} from "@frak/atelier-shared";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { Bot, CircleDot, Radio } from "lucide-react";
import { useState } from "react";
import { sandboxDetailQuery } from "@/api/queries/sandboxes";
import {
  permissionsQuery,
  questionsQuery,
  sessionStatusesQuery,
  sessionsListQuery,
  useAbortSession,
  useDeleteSession,
  useRejectQuestion,
  useReplyPermission,
  useReplyQuestion,
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
import { EmptyState } from "@/components/ui/empty-state";
import { useAgentEvents } from "@/hooks/use-agent-events";
import {
  permissionPresentation,
  riskBadgeVariant,
} from "@/lib/status-presentation";
import { useLens } from "@/providers/lens";

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
        <Badge variant={connected ? "success" : "secondary"}>
          <Radio className="mr-1 size-3" />
          {connected ? "Live" : "Reconnecting"}
        </Badge>
      </div>

      <PermissionsSection sandboxId={sandboxId} />
      <QuestionsSection sandboxId={sandboxId} />

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

// ── permissions ────────────────────────────────────────────────────────────

function PermissionsSection({ sandboxId }: { sandboxId: string }) {
  const { data: permissions } = useQuery(permissionsQuery(sandboxId));
  if (!permissions || permissions.length === 0) return null;

  return (
    <Card className="border-warning/40">
      <CardHeader>
        <CardTitle>Permission requests</CardTitle>
        <CardDescription>The agent is waiting on your reply.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-2">
        {permissions.map((request) => (
          <PermissionRow
            key={request.id}
            sandboxId={sandboxId}
            request={request}
          />
        ))}
      </CardContent>
    </Card>
  );
}

function PermissionRow({
  sandboxId,
  request,
}: {
  sandboxId: string;
  request: AgentPermissionRequest;
}) {
  const reply = useReplyPermission(sandboxId);
  const { lens } = useLens();
  const presentation = permissionPresentation(request.permission);

  return (
    <div className="rounded-md border p-3">
      <div className="flex flex-wrap items-center gap-2">
        <CircleDot className="size-4 shrink-0 text-warning" />
        <span className="font-medium">{presentation.what}</span>
        <Badge variant={riskBadgeVariant(presentation.risk)}>
          {presentation.riskLabel}
        </Badge>
      </div>
      {lens === "builder" ? (
        <div className="mt-1 space-y-0.5">
          <p className="font-mono text-xs text-muted-foreground">
            {request.permission}
          </p>
          {request.patterns && request.patterns.length > 0 ? (
            <ul className="space-y-0.5 font-mono text-xs text-muted-foreground">
              {request.patterns.map((pattern) => (
                <li key={pattern}>{pattern}</li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
      <div className="mt-2 flex gap-2">
        <Button
          size="sm"
          disabled={reply.isPending}
          onClick={() => reply.mutate({ requestId: request.id, reply: "once" })}
        >
          Allow once
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={reply.isPending}
          onClick={() =>
            reply.mutate({ requestId: request.id, reply: "always" })
          }
        >
          Always
        </Button>
        <Button
          size="sm"
          variant="destructive"
          disabled={reply.isPending}
          onClick={() =>
            reply.mutate({ requestId: request.id, reply: "reject" })
          }
        >
          Reject
        </Button>
      </div>
    </div>
  );
}

// ── questions ──────────────────────────────────────────────────────────────

function QuestionsSection({ sandboxId }: { sandboxId: string }) {
  const { data: questions } = useQuery(questionsQuery(sandboxId));
  if (!questions || questions.length === 0) return null;

  return (
    <Card className="border-warning/40">
      <CardHeader>
        <CardTitle>Questions</CardTitle>
      </CardHeader>
      <CardContent className="space-y-2">
        {questions.map((request) => (
          <QuestionRow
            key={request.id}
            sandboxId={sandboxId}
            request={request}
          />
        ))}
      </CardContent>
    </Card>
  );
}

function QuestionRow({
  sandboxId,
  request,
}: {
  sandboxId: string;
  request: AgentQuestionRequest;
}) {
  const reply = useReplyQuestion(sandboxId);
  const reject = useRejectQuestion(sandboxId);

  return (
    <div className="space-y-2 rounded-md border p-3">
      {request.questions.map((question) => (
        <div key={question.header} className="space-y-1">
          <p className="text-sm font-medium">{question.header}</p>
          <p className="text-sm text-muted-foreground">{question.question}</p>
          <div className="flex flex-wrap gap-2 pt-1">
            {question.options.map((option) => (
              <Button
                key={option.label}
                size="sm"
                variant="outline"
                disabled={reply.isPending}
                onClick={() =>
                  reply.mutate({
                    requestId: request.id,
                    answers: [[option.label]],
                  })
                }
              >
                {option.label}
              </Button>
            ))}
          </div>
        </div>
      ))}
      <Button
        size="sm"
        variant="ghost"
        disabled={reject.isPending}
        onClick={() => reject.mutate(request.id)}
      >
        Reject
      </Button>
    </div>
  );
}
