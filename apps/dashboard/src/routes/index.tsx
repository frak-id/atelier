import type { Task } from "@frak-sandbox/manager/types";
import { useQueries, useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import {
  AlertCircle,
  Bot,
  CheckCircle,
  ExternalLink,
  Kanban,
  Loader2,
  Server,
} from "lucide-react";
import { Component, type ReactNode, Suspense } from "react";
import {
  sandboxDevCommandsQuery,
  sandboxListQuery,
  taskListQuery,
  useDeleteSandbox,
  useRestartSandbox,
  useStartSandbox,
  useStopSandbox,
  useWorkspaceMap,
  workspaceListQuery,
} from "@/api/queries";
import { AttentionBlock } from "@/components/attention-block";
import { SandboxCard } from "@/components/sandbox-card";
import { StartWorkingCard } from "@/components/start-working-card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { Skeleton } from "@/components/ui/skeleton";
import { useAttentionData } from "@/hooks/use-attention-data";
import { useTaskSessionProgress } from "@/hooks/use-task-session-progress";
import { formatDate } from "@/lib/utils";
import { useDrawer } from "@/providers/drawer-provider";

class SectionErrorBoundary extends Component<
  { children: ReactNode; fallback?: ReactNode },
  { hasError: boolean }
> {
  constructor(props: { children: ReactNode; fallback?: ReactNode }) {
    super(props);
    this.state = { hasError: false };
  }
  static getDerivedStateFromError() {
    return { hasError: true };
  }
  render() {
    if (this.state.hasError) {
      return (
        this.props.fallback || (
          <div className="p-4 border border-destructive/50 rounded bg-destructive/10 text-destructive text-sm flex items-center gap-2">
            <AlertCircle className="h-4 w-4" />
            Failed to load section
          </div>
        )
      );
    }
    return this.props.children;
  }
}

export const Route = createFileRoute("/")({
  component: MissionControlPage,
  loader: ({ context }) => {
    context.queryClient.ensureQueryData(workspaceListQuery());
    context.queryClient.ensureQueryData(sandboxListQuery());
  },
  pendingComponent: MissionControlSkeleton,
});

function MissionControlPage() {
  const { openTask, openSandbox } = useDrawer();

  return (
    <div className="p-6 space-y-8 max-w-7xl mx-auto">
      <div className="space-y-2">
        <h1 className="text-3xl font-bold tracking-tight">Mission Control</h1>
        <p className="text-muted-foreground">
          Overview of all active operations across your sandboxes.
        </p>
      </div>

      <div className="space-y-8">
        <SectionErrorBoundary>
          <Suspense fallback={<Skeleton className="h-48 w-full" />}>
            <AttentionSection />
          </Suspense>
        </SectionErrorBoundary>

        <SectionErrorBoundary>
          <Suspense fallback={<Skeleton className="h-64 w-full" />}>
            <StartWorkingCard />
          </Suspense>
        </SectionErrorBoundary>

        <SectionErrorBoundary>
          <Suspense fallback={<Skeleton className="h-64 w-full" />}>
            <ActiveTasksSection onSelectTask={openTask} />
          </Suspense>
        </SectionErrorBoundary>

        <SectionErrorBoundary>
          <Suspense fallback={<Skeleton className="h-64 w-full" />}>
            <RunningSandboxesSection
              onSelectSandbox={openSandbox}
              onSelectTask={openTask}
            />
          </Suspense>
        </SectionErrorBoundary>

        <SectionErrorBoundary>
          <Suspense fallback={<Skeleton className="h-32 w-full" />}>
            <DevCommandsSection />
          </Suspense>
        </SectionErrorBoundary>
      </div>
    </div>
  );
}

function AttentionSection() {
  const { groups, isLoading, count } = useAttentionData();
  const { openSandbox } = useDrawer();

  if (isLoading) {
    return <Skeleton className="h-32 w-full" />;
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <h2 className="text-xl font-semibold flex items-center gap-2">
          Needs Attention
          {count > 0 && <Badge variant="destructive">{count}</Badge>}
        </h2>
      </div>

      {groups.length === 0 ? (
        <Card className="bg-muted/5 border-dashed">
          <CardContent className="flex items-center gap-4 py-6">
            <div className="h-10 w-10 rounded-full bg-green-500/10 flex items-center justify-center shrink-0">
              <CheckCircle className="h-6 w-6 text-green-500" />
            </div>
            <div>
              <p className="font-medium">All clear</p>
              <p className="text-sm text-muted-foreground">
                No pending permissions or questions across running sessions.
              </p>
            </div>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-3">
          {groups.map((group) => (
            <AttentionBlock
              key={group.sandboxId}
              permissions={group.permissions}
              questions={group.questions}
              opencodeUrl={group.opencodeUrl}
              sandboxId={group.sandboxId}
              workspaceName={group.workspaceName}
              onOpenSandbox={openSandbox}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function ActiveTasksSection({
  onSelectTask,
}: {
  onSelectTask: (id: string) => void;
}) {
  const { data: tasks } = useQuery({
    ...taskListQuery(),
    select: (tasks) => tasks?.filter((t) => t.status === "active"),
  });
  const workspaceMap = useWorkspaceMap();

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <h2 className="text-xl font-semibold flex items-center gap-2">
          Active Tasks
          {tasks && tasks.length > 0 && (
            <Badge variant="default">{tasks.length}</Badge>
          )}
        </h2>
      </div>

      {!tasks || tasks.length === 0 ? (
        <Card className="bg-muted/5 border-dashed">
          <CardContent className="flex flex-col items-center justify-center py-8 text-center">
            <Kanban className="h-10 w-10 text-muted-foreground/50 mb-3" />
            <p className="font-medium text-muted-foreground">No active tasks</p>
            <Button variant="link" size="sm" asChild>
              <a href="/tasks">Go to Task Board</a>
            </Button>
          </CardContent>
        </Card>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {tasks.map((task) => (
            <ActiveTaskCard
              key={task.id}
              task={task}
              workspaceName={workspaceMap.get(task.workspaceId)}
              onClick={() => onSelectTask(task.id)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function ActiveTaskCard({
  task,
  workspaceName,
  onClick,
}: {
  task: Task;
  workspaceName?: string;
  onClick: () => void;
}) {
  const { data: sandboxes } = useQuery(sandboxListQuery());
  const sandbox = sandboxes?.find((s) => s.id === task.data.sandboxId);

  // We only fetch progress if we have the sandbox URL
  const { progressPercent, allCount, completedSubsessionCount, isLoading } =
    useTaskSessionProgress(
      task,
      sandbox?.runtime?.urls?.opencode,
      undefined,
      !!sandbox?.runtime?.urls?.opencode,
    );

  return (
    <Card
      className="cursor-pointer hover:border-primary/50 transition-colors"
      onClick={onClick}
    >
      <CardHeader className="pb-2">
        <div className="flex justify-between items-start gap-2">
          <div className="space-y-1 min-w-0">
            <CardTitle className="text-base truncate" title={task.title}>
              {task.title}
            </CardTitle>
            <CardDescription className="flex items-center gap-2">
              <span className="truncate max-w-[150px]">
                {workspaceName || "Unknown Workspace"}
              </span>
            </CardDescription>
          </div>
          <Badge variant="default" className="shrink-0">
            Active
          </Badge>
        </div>
      </CardHeader>
      <CardContent className="pb-4 space-y-4">
        <div className="space-y-1.5">
          <div className="flex justify-between text-xs text-muted-foreground">
            <span>Progress</span>
            {isLoading ? (
              <Loader2 className="h-3 w-3 animate-spin" />
            ) : (
              <span>{progressPercent}%</span>
            )}
          </div>
          <Progress value={progressPercent} className="h-2" />
        </div>

        <div className="flex items-center justify-between text-xs text-muted-foreground">
          <div className="flex items-center gap-1.5">
            <Bot className="h-3.5 w-3.5" />
            <span>
              {completedSubsessionCount}/{allCount} sessions
            </span>
          </div>
          <div>{formatDate(task.data.startedAt || task.createdAt)}</div>
        </div>
      </CardContent>
    </Card>
  );
}

function RunningSandboxesSection({
  onSelectSandbox,
  onSelectTask,
}: {
  onSelectSandbox: (id: string) => void;
  onSelectTask: (id: string) => void;
}) {
  const { data: sandboxes } = useQuery(sandboxListQuery());
  const { data: tasks } = useQuery(taskListQuery());
  const runningSandboxes =
    sandboxes?.filter((s) => s.status === "running") ?? [];
  const workspaceDataMap = useQuery({
    ...workspaceListQuery(),
    select: (workspaces) => {
      const map = new Map();
      for (const w of workspaces ?? []) map.set(w.id, w);
      return map;
    },
  }).data;

  const deleteSandbox = useDeleteSandbox();
  const stopSandbox = useStopSandbox();
  const startSandbox = useStartSandbox();
  const restartSandbox = useRestartSandbox();

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <h2 className="text-xl font-semibold flex items-center gap-2">
          Running Sandboxes
          {runningSandboxes.length > 0 && (
            <Badge variant="outline">{runningSandboxes.length}</Badge>
          )}
        </h2>
      </div>

      {runningSandboxes.length === 0 ? (
        <Card className="bg-muted/5 border-dashed">
          <CardContent className="flex flex-col items-center justify-center py-8 text-center">
            <Server className="h-10 w-10 text-muted-foreground/50 mb-3" />
            <p className="font-medium text-muted-foreground">
              No sandboxes running
            </p>
            <p className="text-sm text-muted-foreground/70 mt-1">
              Start a session above to spin up a sandbox
            </p>
          </CardContent>
        </Card>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          {runningSandboxes.map((sandbox) => {
            const task = tasks?.find((t) => t.data.sandboxId === sandbox.id);
            return (
              <SandboxCard
                key={sandbox.id}
                sandbox={sandbox}
                workspace={
                  sandbox.workspaceId
                    ? workspaceDataMap?.get(sandbox.workspaceId)
                    : undefined
                }
                task={task}
                onShowDetails={() => onSelectSandbox(sandbox.id)}
                onDelete={() => deleteSandbox.mutate(sandbox.id)}
                onStop={() => stopSandbox.mutate(sandbox.id)}
                onStart={() => startSandbox.mutate(sandbox.id)}
                onRecreate={() => restartSandbox.mutate(sandbox.id)}
                isStopping={stopSandbox.isPending}
                isStarting={startSandbox.isPending}
                isRecreating={restartSandbox.isPending}
                onShowTask={() => {
                  if (task) onSelectTask(task.id);
                }}
              />
            );
          })}
        </div>
      )}
    </div>
  );
}

function DevCommandsSection() {
  const { data: sandboxes } = useQuery(sandboxListQuery());
  const runningSandboxes =
    sandboxes?.filter((s) => s.status === "running") ?? [];

  // We need to fetch dev commands for all running sandboxes
  const devCommandsQueries = useQueries({
    queries: runningSandboxes.map((sandbox) => ({
      ...sandboxDevCommandsQuery(sandbox.id),
      meta: { sandbox },
    })),
  });

  const activeCommands = devCommandsQueries.flatMap((q, i) => {
    const sandbox = runningSandboxes[i];
    if (!sandbox) return [];
    const commands = q.data?.commands ?? [];
    return commands
      .filter((c) => c.status === "running")
      .map((c) => ({ ...c, sandbox }));
  });

  if (activeCommands.length === 0) {
    return null;
  }

  return (
    <div className="space-y-4">
      <h2 className="text-xl font-semibold flex items-center gap-2">
        Dev Servers
        <Badge variant="secondary" className="bg-green-500/10 text-green-600">
          {activeCommands.length} Active
        </Badge>
      </h2>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {activeCommands.map((cmd) => (
          <Card key={`${cmd.sandbox.id}-${cmd.name}`} className="bg-muted/30">
            <CardContent className="p-4 flex items-center justify-between">
              <div className="space-y-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="font-medium truncate">{cmd.name}</span>
                  <Badge variant="outline" className="text-xs h-5 px-1.5">
                    {cmd.sandbox.id}
                  </Badge>
                </div>
                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                  <span className="h-1.5 w-1.5 rounded-full bg-green-500 animate-pulse" />
                  Running
                </div>
              </div>
              {cmd.devUrl && (
                <Button variant="ghost" size="icon" asChild>
                  <a
                    href={cmd.devUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    title="Open Dev Server"
                  >
                    <ExternalLink className="h-4 w-4" />
                  </a>
                </Button>
              )}
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}

function MissionControlSkeleton() {
  return (
    <div className="p-6 space-y-8 max-w-7xl mx-auto">
      <div className="space-y-2">
        <Skeleton className="h-9 w-64" />
        <Skeleton className="h-5 w-96" />
      </div>

      <div className="space-y-8">
        <Skeleton className="h-32 w-full" />
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <Skeleton className="h-48" />
          <Skeleton className="h-48" />
          <Skeleton className="h-48" />
        </div>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
          <Skeleton className="h-64" />
          <Skeleton className="h-64" />
          <Skeleton className="h-64" />
        </div>
      </div>
    </div>
  );
}
