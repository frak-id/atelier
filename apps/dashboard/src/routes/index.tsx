import type { TaskEffort } from "@frak-sandbox/shared/constants";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { Suspense, useCallback } from "react";
import {
  sandboxListQuery,
  taskListQuery,
  useCreateTask,
  workspaceListQuery,
} from "@/api/queries";
import { AttentionList } from "@/components/dashboard/attention-list";
import { QuickStart } from "@/components/dashboard/quick-start";
import { RunningSessions } from "@/components/dashboard/running-sessions";
import { StatusOverview } from "@/components/dashboard/status-overview";
import { PageHeader } from "@/components/layout/page-header";
import { Skeleton } from "@/components/ui/skeleton";
import {
  useAttentionTasks,
  useRunningSessions,
  useStatusCounts,
} from "@/hooks/use-attention-tasks";
import { useStartSession } from "@/hooks/use-start-session";

export const Route = createFileRoute("/")({
  component: HomePage,
  loader: ({ context }) => {
    context.queryClient.ensureQueryData(workspaceListQuery());
    context.queryClient.ensureQueryData(sandboxListQuery());
    context.queryClient.ensureQueryData(taskListQuery());
  },
  pendingComponent: HomeSkeleton,
});

function HomePage() {
  return (
    <div className="p-6 space-y-6">
      <PageHeader
        title="Dashboard"
        description="Overview of your dev environments and tasks"
      />

      <Suspense fallback={<Skeleton className="h-24" />}>
        <DashboardContent />
      </Suspense>
    </div>
  );
}

function DashboardContent() {
  const statusCounts = useStatusCounts();
  const { items: attentionItems } = useAttentionTasks();
  const runningSessions = useRunningSessions();

  const { data: workspaces } = useQuery(workspaceListQuery());
  const createTaskMutation = useCreateTask();
  const startSessionMutation = useStartSession();

  const handleCreateTask = useCallback(
    (
      workspaceId: string,
      title: string,
      description: string,
      effort: TaskEffort,
    ) => {
      createTaskMutation.mutate({
        workspaceId,
        title,
        description,
        effort,
      });
    },
    [createTaskMutation],
  );

  const handleStartChat = useCallback(
    (workspaceId: string, effort: TaskEffort) => {
      const workspace = workspaces?.find((w) => w.id === workspaceId);
      if (!workspace) return;

      startSessionMutation.mutate({
        workspace,
        message:
          "Hello! I'm starting a new chat session. What would you like to work on?",
        effort,
      });
    },
    [workspaces, startSessionMutation],
  );

  return (
    <div className="space-y-6">
      <StatusOverview counts={statusCounts} />

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="lg:col-span-2 space-y-6">
          <AttentionList items={attentionItems} />
          <RunningSessions sessions={runningSessions} maxItems={5} />
        </div>

        <div>
          <QuickStart
            onCreateTask={handleCreateTask}
            onStartChat={handleStartChat}
            isCreating={
              createTaskMutation.isPending || startSessionMutation.isPending
            }
          />
        </div>
      </div>
    </div>
  );
}

function HomeSkeleton() {
  return (
    <div className="p-6 space-y-6">
      <div>
        <Skeleton className="h-9 w-48" />
        <Skeleton className="h-4 w-64 mt-2" />
      </div>
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
        {Array.from({ length: 5 }).map((_, i) => (
          <Skeleton key={i} className="h-24" />
        ))}
      </div>
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="lg:col-span-2 space-y-6">
          <Skeleton className="h-[200px]" />
          <Skeleton className="h-[300px]" />
        </div>
        <Skeleton className="h-[350px]" />
      </div>
    </div>
  );
}
