import type { Task } from "@frak-sandbox/manager/types";
import type { Session } from "@opencode-ai/sdk/v2";
import { useQuery, useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import {
  ArrowLeft,
  CheckCircle,
  Clock,
  ExternalLink,
  GitBranch,
  Loader2,
  MessageSquare,
} from "lucide-react";
import { useMemo } from "react";
import {
  opencodeSessionsQuery,
  sandboxDetailQuery,
  taskDetailQuery,
  workspaceDetailQuery,
} from "@/api/queries";
import { PageHeader } from "@/components/layout/page-header";
import { QuickActions } from "@/components/shared/quick-actions";
import {
  type IndicatorStatus,
  StatusIndicator,
} from "@/components/shared/status-indicator";
import { TimeAgo } from "@/components/shared/time-ago";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { Skeleton } from "@/components/ui/skeleton";
import { buildOpenCodeSessionUrl } from "@/lib/utils";

export const Route = createFileRoute("/tasks/$id")({
  component: TaskDetailPage,
  loader: async ({ context, params }) => {
    return context.queryClient.ensureQueryData(taskDetailQuery(params.id));
  },
  pendingComponent: TaskDetailSkeleton,
});

function getTaskStatusIndicator(status: string): IndicatorStatus {
  switch (status) {
    case "draft":
      return "draft";
    case "queue":
      return "queued";
    case "in_progress":
      return "running";
    case "pending_review":
      return "review";
    case "completed":
      return "complete";
    default:
      return "idle";
  }
}

function TaskDetailPage() {
  const { id } = Route.useParams();
  const { data: task } = useSuspenseQuery(taskDetailQuery(id));

  if (!task) {
    return (
      <div className="p-6">
        <PageHeader
          title="Task Not Found"
          description="The requested task does not exist"
        />
      </div>
    );
  }

  return (
    <div className="p-6 space-y-6">
      <TaskHeader task={task} />
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="lg:col-span-2 space-y-6">
          <ChatEmbed task={task} />
          <SubSessionsList task={task} />
        </div>
        <div>
          <TaskInfoPanel task={task} />
        </div>
      </div>
    </div>
  );
}

function TaskHeader({ task }: { task: Task }) {
  const { data: sandbox } = useQuery({
    ...sandboxDetailQuery(task.data.sandboxId ?? ""),
    enabled: !!task.data.sandboxId,
  });

  const showQuickActions =
    (task.status === "in_progress" || task.status === "pending_review") &&
    sandbox?.status === "running";

  const statusIndicator = getTaskStatusIndicator(task.status);

  return (
    <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
      <div className="space-y-1">
        <Link
          to="/tasks"
          className="text-sm text-muted-foreground hover:text-foreground inline-flex items-center gap-1"
        >
          <ArrowLeft className="h-3 w-3" /> Back to Tasks
        </Link>
        <div className="flex items-center gap-3">
          <StatusIndicator
            status={statusIndicator}
            size="lg"
            pulse={task.status === "in_progress"}
          />
          <h1 className="text-2xl font-bold tracking-tight">{task.title}</h1>
        </div>
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Badge variant="outline">{task.status.replace("_", " ")}</Badge>
          <span>•</span>
          <TimeAgo date={task.updatedAt} />
        </div>
      </div>

      {showQuickActions && sandbox && (
        <QuickActions
          vscodeUrl={sandbox.runtime.urls.vscode}
          terminalUrl={sandbox.runtime.urls.terminal}
          opencodeUrl={sandbox.runtime.urls.opencode}
          sshCommand={sandbox.runtime.urls.ssh}
          size="default"
        />
      )}
    </div>
  );
}

function ChatEmbed({ task }: { task: Task }) {
  const { data: sandbox } = useQuery({
    ...sandboxDetailQuery(task.data.sandboxId ?? ""),
    enabled: !!task.data.sandboxId,
  });

  const opencodeUrl = sandbox?.runtime?.urls?.opencode
    ? new URL(sandbox.runtime.urls.opencode).origin
    : null;

  const sessionUrl =
    opencodeUrl && task.data.opencodeSessionId
      ? buildOpenCodeSessionUrl(
          opencodeUrl,
          "/home/dev/workspace",
          task.data.opencodeSessionId,
        )
      : null;

  const needsInput = task.status === "pending_review";

  return (
    <Card className={needsInput ? "border-amber-500/50" : ""}>
      <CardHeader className="flex flex-row items-center justify-between pb-2">
        <CardTitle className="flex items-center gap-2 text-base">
          <MessageSquare className="h-4 w-4" />
          Session Chat
          {needsInput && (
            <Badge
              variant="outline"
              className="text-amber-600 border-amber-500"
            >
              Waiting for input
            </Badge>
          )}
        </CardTitle>
        {sessionUrl && (
          <Button variant="ghost" size="sm" asChild>
            <a href={sessionUrl} target="_blank" rel="noopener noreferrer">
              Open Full <ExternalLink className="h-3 w-3 ml-1" />
            </a>
          </Button>
        )}
      </CardHeader>
      <CardContent>
        <div className="space-y-4">
          <div className="bg-muted/50 rounded-lg p-4">
            <div className="text-xs text-muted-foreground mb-1 font-medium">
              Task Description
            </div>
            <p className="text-sm whitespace-pre-wrap line-clamp-4">
              {task.data.description}
            </p>
          </div>

          {task.data.context && (
            <div className="bg-muted/30 rounded-lg p-4">
              <div className="text-xs text-muted-foreground mb-1 font-medium">
                Additional Context
              </div>
              <p className="text-sm whitespace-pre-wrap text-muted-foreground line-clamp-3">
                {task.data.context}
              </p>
            </div>
          )}

          {sessionUrl && (
            <div className="pt-2">
              <Button variant="outline" className="w-full" asChild>
                <a href={sessionUrl} target="_blank" rel="noopener noreferrer">
                  <MessageSquare className="h-4 w-4 mr-2" />
                  View Full Conversation
                </a>
              </Button>
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

function SubSessionsList({ task }: { task: Task }) {
  const { data: sandbox } = useQuery({
    ...sandboxDetailQuery(task.data.sandboxId ?? ""),
    enabled: !!task.data.sandboxId,
  });

  const opencodeUrl = sandbox?.runtime?.urls?.opencode
    ? new URL(sandbox.runtime.urls.opencode).origin
    : null;

  const { data: sessions } = useQuery({
    ...opencodeSessionsQuery(opencodeUrl ?? ""),
    enabled: !!opencodeUrl,
  });

  const isTaskInProgress = task.status === "in_progress";
  const { subSessions, completedCount, totalCount, progressPercent } =
    useSubSessionProgress(
      sessions,
      task.data.opencodeSessionId,
      isTaskInProgress,
    );

  if (totalCount === 0) {
    return null;
  }

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center justify-between text-base">
          <span>Sub-sessions</span>
          <span className="text-sm font-normal text-muted-foreground">
            {completedCount}/{totalCount}
          </span>
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className="space-y-3">
          <Progress value={progressPercent} className="h-2" />
          <div className="space-y-1 max-h-[300px] overflow-y-auto">
            {subSessions.map((session) => (
              <SubSessionRow
                key={session.id}
                session={session}
                opencodeUrl={opencodeUrl}
              />
            ))}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

function SubSessionRow({
  session,
  opencodeUrl,
}: {
  session: Session;
  opencodeUrl: string | null;
}) {
  const isCompleted = session.parentID
    ? session.time.updated !== session.time.created
    : false;

  const displayTitle = session.title || `Session ${session.id.slice(0, 8)}`;

  const sessionUrl = opencodeUrl
    ? buildOpenCodeSessionUrl(opencodeUrl, session.directory, session.id)
    : null;

  return (
    <div className="flex items-center gap-2 text-sm py-2 px-3 bg-muted/50 rounded-lg">
      {isCompleted ? (
        <CheckCircle className="h-4 w-4 text-green-500 shrink-0" />
      ) : session.time.updated === session.time.created ? (
        <Clock className="h-4 w-4 text-yellow-500 shrink-0" />
      ) : (
        <Loader2 className="h-4 w-4 text-blue-500 shrink-0 animate-spin" />
      )}
      <span className="truncate flex-1">{displayTitle}</span>
      <span className="text-xs text-muted-foreground shrink-0">
        {session.time.created
          ? new Date(session.time.created * 1000).toLocaleTimeString()
          : ""}
      </span>
      {sessionUrl && (
        <Button variant="ghost" size="sm" className="h-6 px-2" asChild>
          <a href={sessionUrl} target="_blank" rel="noopener noreferrer">
            <ExternalLink className="h-3 w-3" />
          </a>
        </Button>
      )}
    </div>
  );
}

function TaskInfoPanel({ task }: { task: Task }) {
  const { data: workspace } = useQuery({
    ...workspaceDetailQuery(task.workspaceId),
    enabled: !!task.workspaceId,
  });

  const { data: sandbox } = useQuery({
    ...sandboxDetailQuery(task.data.sandboxId ?? ""),
    enabled: !!task.data.sandboxId,
  });

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base">Task Info</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-3">
          <InfoRow label="Workspace">
            {workspace ? (
              <Link
                to="/workspaces/$id"
                params={{ id: task.workspaceId }}
                className="text-primary hover:underline"
              >
                {workspace.name}
              </Link>
            ) : (
              <span className="text-muted-foreground">Loading...</span>
            )}
          </InfoRow>

          <InfoRow label="Effort">
            <Badge variant="secondary">{task.data.effort ?? "low"}</Badge>
          </InfoRow>

          {task.data.branchName && (
            <InfoRow label="Branch">
              <div className="flex items-center gap-1.5">
                <GitBranch className="h-3.5 w-3.5 text-muted-foreground" />
                <code className="text-xs bg-muted px-1.5 py-0.5 rounded font-mono">
                  {task.data.branchName}
                </code>
              </div>
            </InfoRow>
          )}

          <InfoRow label="Created">
            <TimeAgo date={task.createdAt} />
          </InfoRow>

          {task.data.startedAt && (
            <InfoRow label="Started">
              <TimeAgo date={task.data.startedAt} />
            </InfoRow>
          )}

          {task.data.completedAt && (
            <InfoRow label="Completed">
              <TimeAgo date={task.data.completedAt} />
            </InfoRow>
          )}
        </div>

        {sandbox && (
          <div className="border-t pt-4">
            <h4 className="text-sm font-medium mb-3">Sandbox</h4>
            <div className="space-y-2">
              <InfoRow label="ID">
                <Link
                  to="/sandboxes/$id"
                  params={{ id: sandbox.id }}
                  className="text-primary hover:underline font-mono text-xs"
                >
                  {sandbox.id.slice(0, 12)}...
                </Link>
              </InfoRow>
              <InfoRow label="Status">
                <Badge
                  variant={
                    sandbox.status === "running" ? "default" : "secondary"
                  }
                >
                  {sandbox.status}
                </Badge>
              </InfoRow>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function InfoRow({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-2">
      <span className="text-sm text-muted-foreground">{label}</span>
      <div className="text-sm">{children}</div>
    </div>
  );
}

function useSubSessionProgress(
  sessions: Session[] | undefined,
  parentSessionId: string | undefined,
  isTaskInProgress = false,
) {
  return useMemo(() => {
    if (!sessions || !parentSessionId) {
      return {
        subSessions: [],
        completedCount: 0,
        totalCount: 0,
        progressPercent: 0,
      };
    }

    const subSessions = sessions.filter((s) => s.parentID === parentSessionId);

    const completedCount = subSessions.filter(
      (s) => s.time.updated !== s.time.created,
    ).length;

    const totalCount = isTaskInProgress
      ? subSessions.length + 1
      : subSessions.length;
    const progressPercent =
      totalCount > 0 ? Math.round((completedCount / totalCount) * 100) : 0;

    return {
      subSessions,
      completedCount,
      totalCount,
      progressPercent,
    };
  }, [sessions, parentSessionId, isTaskInProgress]);
}

function TaskDetailSkeleton() {
  return (
    <div className="p-6 space-y-6">
      <div>
        <Skeleton className="h-4 w-24 mb-2" />
        <Skeleton className="h-9 w-64" />
        <Skeleton className="h-4 w-32 mt-2" />
      </div>
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="lg:col-span-2 space-y-6">
          <Skeleton className="h-[200px]" />
          <Skeleton className="h-[150px]" />
        </div>
        <Skeleton className="h-[300px]" />
      </div>
    </div>
  );
}
