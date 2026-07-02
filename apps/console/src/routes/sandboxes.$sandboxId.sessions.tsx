import type {
  AgentPermissionRequest,
  AgentQuestionRequest,
  AgentSession,
  AgentSessionStatus,
  AgentTodo,
} from "@frak/atelier-shared";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { CircleDot, Loader2, Plus, Radio, Square, Trash2 } from "lucide-react";
import { useState } from "react";
import {
  permissionsQuery,
  questionsQuery,
  sessionStatusesQuery,
  sessionsListQuery,
  sessionTodosQuery,
  useAbortSession,
  useDeleteSession,
  useRejectQuestion,
  useReplyPermission,
  useReplyQuestion,
} from "@/api/queries/sessions";
import {
  terminalSessionsQuery,
  useCreateTerminalSession,
  useDeleteTerminalSession,
} from "@/api/queries/terminal";
import { TerminalView } from "@/components/terminal-view";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { useAgentEvents } from "@/hooks/use-agent-events";
import { formatRelativeTime } from "@/lib/formatters";

export const Route = createFileRoute("/sandboxes/$sandboxId/sessions")({
  component: SessionsPage,
});

function SessionsPage() {
  const { sandboxId } = Route.useParams();
  const { connected } = useAgentEvents(sandboxId);
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(
    null,
  );

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

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <SessionsSection
          sandboxId={sandboxId}
          selectedSessionId={selectedSessionId}
          onSelect={setSelectedSessionId}
        />
        <TodosSection sandboxId={sandboxId} sessionId={selectedSessionId} />
      </div>

      <TerminalsSection sandboxId={sandboxId} />
    </div>
  );
}

// ── sessions ───────────────────────────────────────────────────────────────

function sessionStatusBadge(status: AgentSessionStatus | undefined) {
  if (!status) return { label: "unknown", variant: "outline" as const };
  switch (status.type) {
    case "busy":
      return { label: "busy", variant: "warning" as const };
    case "retry":
      return {
        label: `retry ${status.attempt}`,
        variant: "error" as const,
      };
    default:
      return { label: "idle", variant: "secondary" as const };
  }
}

function SessionsSection({
  sandboxId,
  selectedSessionId,
  onSelect,
}: {
  sandboxId: string;
  selectedSessionId: string | null;
  onSelect: (id: string) => void;
}) {
  const {
    data: sessions,
    isPending,
    isError,
    error,
  } = useQuery(sessionsListQuery(sandboxId));
  const { data: statuses } = useQuery(sessionStatusesQuery(sandboxId));

  return (
    <Card>
      <CardHeader>
        <CardTitle>Agent sessions</CardTitle>
      </CardHeader>
      <CardContent className="space-y-2">
        {isPending ? (
          <Skeleton className="h-16 w-full" />
        ) : isError ? (
          <p className="text-sm text-destructive">
            {error instanceof Error ? error.message : "Failed to load"}
          </p>
        ) : !sessions || sessions.length === 0 ? (
          <p className="text-sm text-muted-foreground">No agent sessions.</p>
        ) : (
          sessions.map((session) => (
            <SessionRow
              key={session.id}
              sandboxId={sandboxId}
              session={session}
              status={statuses?.[session.id]}
              selected={session.id === selectedSessionId}
              onSelect={() => onSelect(session.id)}
            />
          ))
        )}
      </CardContent>
    </Card>
  );
}

function SessionRow({
  sandboxId,
  session,
  status,
  selected,
  onSelect,
}: {
  sandboxId: string;
  session: AgentSession;
  status: AgentSessionStatus | undefined;
  selected: boolean;
  onSelect: () => void;
}) {
  const abort = useAbortSession(sandboxId);
  const deleteSession = useDeleteSession(sandboxId);
  const badge = sessionStatusBadge(status);

  return (
    <div
      className={`flex flex-col gap-1 rounded-md border p-3 transition-colors ${
        selected ? "border-primary bg-muted" : ""
      }`}
    >
      <button
        type="button"
        onClick={onSelect}
        className="flex flex-col gap-1 text-left"
      >
        <span className="flex flex-wrap items-center gap-2">
          <span className="truncate font-medium">
            {session.title || "Untitled"}
          </span>
          <Badge variant={badge.variant}>{badge.label}</Badge>
          <span className="ml-auto text-xs text-muted-foreground">
            {formatRelativeTime(new Date(session.time.updated).toISOString())}
          </span>
        </span>
        <span className="truncate font-mono text-xs text-muted-foreground">
          {session.directory}
        </span>
      </button>
      <div className="flex gap-2 pt-1">
        {status?.type === "busy" ? (
          <Button
            size="sm"
            variant="outline"
            disabled={abort.isPending}
            onClick={() => abort.mutate(session.id)}
          >
            <Square />
            Abort
          </Button>
        ) : null}
        <Button
          size="sm"
          variant="outline"
          disabled={deleteSession.isPending}
          onClick={() => deleteSession.mutate(session.id)}
        >
          {deleteSession.isPending ? (
            <Loader2 className="animate-spin" />
          ) : (
            <Trash2 />
          )}
          Delete
        </Button>
      </div>
    </div>
  );
}

// ── todos ────────────────────────────────────────────────────────────────

const TODO_ICON: Record<AgentTodo["status"], string> = {
  pending: "○",
  in_progress: "◐",
  completed: "●",
  cancelled: "✕",
};

function TodosSection({
  sandboxId,
  sessionId,
}: {
  sandboxId: string;
  sessionId: string | null;
}) {
  const { data: todos, isPending } = useQuery(
    sessionTodosQuery(sandboxId, sessionId),
  );

  return (
    <Card>
      <CardHeader>
        <CardTitle>Todos</CardTitle>
        <CardDescription>
          {sessionId ? "For the selected session." : "Select a session."}
        </CardDescription>
      </CardHeader>
      <CardContent>
        {!sessionId ? (
          <p className="text-sm text-muted-foreground">No session selected.</p>
        ) : isPending ? (
          <Skeleton className="h-16 w-full" />
        ) : !todos || todos.length === 0 ? (
          <p className="text-sm text-muted-foreground">No todos.</p>
        ) : (
          <ul className="space-y-1 text-sm">
            {todos.map((todo, index) => (
              <li
                // biome-ignore lint/suspicious/noArrayIndexKey: todos have no id; list re-fetched wholesale
                key={index}
                className={`flex items-start gap-2 ${
                  todo.status === "completed" || todo.status === "cancelled"
                    ? "text-muted-foreground line-through"
                    : ""
                }`}
              >
                <span className="font-mono">{TODO_ICON[todo.status]}</span>
                <span>{todo.content}</span>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

// ── permissions ────────────────────────────────────────────────────────────

function PermissionsSection({ sandboxId }: { sandboxId: string }) {
  const { data: permissions } = useQuery(permissionsQuery(sandboxId));
  if (!permissions || permissions.length === 0) return null;

  return (
    <Card className="border-yellow-500/40">
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

  return (
    <div className="rounded-md border p-3">
      <div className="flex items-center gap-2">
        <CircleDot className="size-4 shrink-0 text-yellow-500" />
        <span className="font-medium">{request.permission}</span>
      </div>
      {request.patterns && request.patterns.length > 0 ? (
        <ul className="mt-1 space-y-0.5 font-mono text-xs text-muted-foreground">
          {request.patterns.map((pattern) => (
            <li key={pattern}>{pattern}</li>
          ))}
        </ul>
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
    <Card className="border-yellow-500/40">
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

// ── terminals ──────────────────────────────────────────────────────────────

function TerminalsSection({ sandboxId }: { sandboxId: string }) {
  const {
    data: terminals,
    isPending,
    isError,
    error,
  } = useQuery(terminalSessionsQuery(sandboxId));
  const create = useCreateTerminalSession(sandboxId);
  const deleteTerminal = useDeleteTerminalSession(sandboxId);
  const [activeId, setActiveId] = useState<string | null>(null);

  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between space-y-0">
        <CardTitle>Terminals</CardTitle>
        <Button
          size="sm"
          disabled={create.isPending}
          onClick={() =>
            create.mutate(
              {},
              { onSuccess: (data) => data && setActiveId(data.id) },
            )
          }
        >
          {create.isPending ? <Loader2 className="animate-spin" /> : <Plus />}
          New terminal
        </Button>
      </CardHeader>
      <CardContent className="space-y-3">
        {isPending ? (
          <Skeleton className="h-10 w-full" />
        ) : isError ? (
          <p className="text-sm text-muted-foreground">
            {error instanceof Error ? error.message : "Terminal unavailable"}
          </p>
        ) : !terminals || terminals.length === 0 ? (
          <p className="text-sm text-muted-foreground">No terminals.</p>
        ) : (
          <div className="flex flex-wrap gap-2">
            {terminals.map((terminal) => (
              <div key={terminal.id} className="flex items-center gap-1">
                <Button
                  size="sm"
                  variant={terminal.id === activeId ? "default" : "outline"}
                  onClick={() => setActiveId(terminal.id)}
                >
                  {terminal.title || terminal.id}
                </Button>
                <Button
                  size="icon"
                  variant="ghost"
                  disabled={deleteTerminal.isPending}
                  onClick={() => {
                    if (terminal.id === activeId) setActiveId(null);
                    deleteTerminal.mutate(terminal.id);
                  }}
                  aria-label="Close terminal"
                >
                  <Trash2 />
                </Button>
              </div>
            ))}
          </div>
        )}
        {activeId ? (
          <div className="overflow-hidden rounded-md border">
            <TerminalView
              wsPath={`/sessions/sandboxes/${sandboxId}/terminal/sessions/${activeId}/ws`}
            />
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}
