import type { Task } from "@frak-sandbox/manager/types";
import { useQuery, useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import {
  Archive,
  ChevronDown,
  ChevronRight,
  GitBranch,
  LayoutGrid,
  List as ListIcon,
  Loader2,
  Play,
} from "lucide-react";
import { Suspense, useEffect, useState } from "react";
import {
  sandboxDetailQuery,
  taskListQuery,
  useCompleteTask,
  useStartTask,
  useWorkspaceMap,
  workspaceListQuery,
} from "@/api/queries";
import {
  KanbanBoard,
  TaskDeleteDialog,
  TaskFormDialog,
} from "@/components/kanban";
import { TaskMenu, TaskSessionsStatus } from "@/components/kanban/task-card";
import { TaskDrawer } from "@/components/task-drawer";
import { TodoProgressBar } from "@/components/todo-progress-bar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useTaskSessionProgress } from "@/hooks/use-task-session-progress";
import { formatDate } from "@/lib/utils";

type TasksSearch = {
  expanded?: string;
};

export const Route = createFileRoute("/tasks/")({
  component: TasksPage,
  validateSearch: (search: Record<string, unknown>): TasksSearch => ({
    expanded: typeof search.expanded === "string" ? search.expanded : undefined,
  }),
  loader: ({ context }) => {
    context.queryClient.ensureQueryData(workspaceListQuery());
  },
  pendingComponent: TasksSkeleton,
});

function TasksPage() {
  const { data: workspaces } = useSuspenseQuery(workspaceListQuery());
  const workspaceList = workspaces ?? [];
  const { expanded } = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });

  const expandedIds = expanded ? expanded.split(",").filter(Boolean) : [];

  const [view, setView] = useState(
    () => localStorage.getItem("frak_task_view") || "list",
  );
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [isFormOpen, setIsFormOpen] = useState(false);
  const [editingTask, setEditingTask] = useState<Task | undefined>();
  const [activeWorkspaceId, setActiveWorkspaceId] = useState<string>("");
  const [deletingTask, setDeletingTask] = useState<Task | null>(null);

  useEffect(() => {
    localStorage.setItem("frak_task_view", view);
  }, [view]);

  const toggleExpanded = (workspaceId: string) => {
    const isCurrentlyExpanded = expandedIds.includes(workspaceId);

    const newExpanded = isCurrentlyExpanded
      ? expandedIds.filter((id) => id !== workspaceId)
      : [...expandedIds, workspaceId];

    navigate({
      search: {
        expanded: newExpanded.length > 0 ? newExpanded.join(",") : undefined,
      },
    });
  };

  const handleCreateTask = (workspaceId: string) => {
    setActiveWorkspaceId(workspaceId);
    setEditingTask(undefined);
    setIsFormOpen(true);
  };

  const handleEditTask = (task: Task, workspaceId: string) => {
    setActiveWorkspaceId(workspaceId);
    setEditingTask(task);
    setIsFormOpen(true);
  };

  const handleDeleteTask = (task: Task) => {
    setDeletingTask(task);
  };

  const handleTaskClick = (task: Task) => {
    setSelectedTaskId(task.id);
  };

  if (workspaceList.length === 0) {
    return (
      <div className="p-6">
        <div className="text-center py-12">
          <h2 className="text-lg font-semibold mb-2">No Workspaces</h2>
          <p className="text-muted-foreground">
            Create a workspace first to start managing tasks.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="p-6 space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold sm:text-3xl">Tasks</h1>
          <p className="text-muted-foreground">
            Manage AI coding tasks with kanban boards per workspace
          </p>
        </div>
        <Tabs value={view} onValueChange={setView}>
          <TabsList>
            <TabsTrigger value="list" className="gap-2">
              <ListIcon className="h-4 w-4" />
              List
            </TabsTrigger>
            <TabsTrigger value="board" className="gap-2">
              <LayoutGrid className="h-4 w-4" />
              Board
            </TabsTrigger>
          </TabsList>
        </Tabs>
      </div>

      {view === "list" ? (
        <TasksListView
          onTaskClick={handleTaskClick}
          onEditTask={handleEditTask}
          onDeleteTask={handleDeleteTask}
        />
      ) : (
        <div className="space-y-8">
          {workspaceList.map((workspace) => {
            const isExpanded = expandedIds.includes(workspace.id);

            return (
              <section key={workspace.id}>
                <button
                  type="button"
                  onClick={() => toggleExpanded(workspace.id)}
                  className="flex items-center justify-between w-full text-left pb-3 border-b"
                >
                  <div className="flex items-center gap-2">
                    {isExpanded ? (
                      <ChevronDown className="h-4 w-4 text-muted-foreground" />
                    ) : (
                      <ChevronRight className="h-4 w-4 text-muted-foreground" />
                    )}
                    <h2 className="font-semibold">{workspace.name}</h2>
                  </div>
                  <WorkspaceTaskCount workspaceId={workspace.id} />
                </button>

                {isExpanded && (
                  <div className="pt-4">
                    <Suspense fallback={<KanbanSkeleton />}>
                      <WorkspaceKanban
                        workspaceId={workspace.id}
                        onCreateTask={() => handleCreateTask(workspace.id)}
                        onTaskClick={handleTaskClick}
                        onEditTask={(task) =>
                          handleEditTask(task, workspace.id)
                        }
                        onDeleteTask={handleDeleteTask}
                      />
                    </Suspense>
                  </div>
                )}
              </section>
            );
          })}
        </div>
      )}

      <TaskDrawer
        taskId={selectedTaskId}
        onClose={() => setSelectedTaskId(null)}
      />

      <TaskFormDialog
        open={isFormOpen}
        onOpenChange={setIsFormOpen}
        workspaceId={activeWorkspaceId}
        task={editingTask}
      />

      <TaskDeleteDialog
        open={!!deletingTask}
        onOpenChange={(open) => !open && setDeletingTask(null)}
        task={deletingTask}
      />
    </div>
  );
}

interface WorkspaceTaskCountProps {
  workspaceId: string;
}

function WorkspaceTaskCount({ workspaceId }: WorkspaceTaskCountProps) {
  const { data: tasks } = useQuery({
    ...taskListQuery(workspaceId),
  });

  const taskCount = tasks?.length ?? 0;
  const activeCount = tasks?.filter((t) => t.status === "active").length ?? 0;

  return (
    <div className="flex items-center gap-2 text-sm text-muted-foreground">
      {activeCount > 0 && (
        <Badge variant="default" className="text-xs">
          {activeCount} active
        </Badge>
      )}
      <span>
        {taskCount} task{taskCount !== 1 ? "s" : ""}
      </span>
    </div>
  );
}

interface WorkspaceKanbanProps {
  workspaceId: string;
  onCreateTask: () => void;
  onTaskClick: (task: Task) => void;
  onEditTask: (task: Task) => void;
  onDeleteTask: (task: Task) => void;
}

function WorkspaceKanban({
  workspaceId,
  onCreateTask,
  onTaskClick,
  onEditTask,
  onDeleteTask,
}: WorkspaceKanbanProps) {
  const { data: tasks } = useSuspenseQuery(taskListQuery(workspaceId));
  const taskList = tasks ?? [];

  return (
    <KanbanBoard
      tasks={taskList}
      onCreateTask={onCreateTask}
      onTaskClick={onTaskClick}
      onEditTask={onEditTask}
      onDeleteTask={onDeleteTask}
    />
  );
}

function TasksSkeleton() {
  return (
    <div className="p-6 space-y-6">
      <div>
        <Skeleton className="h-9 w-32" />
        <Skeleton className="h-4 w-64 mt-2" />
      </div>
      <div className="space-y-4">
        {[1, 2, 3].map((i) => (
          <Skeleton key={i} className="h-16 rounded-lg" />
        ))}
      </div>
    </div>
  );
}

function KanbanSkeleton() {
  return (
    <div className="flex gap-4 overflow-x-auto pb-4">
      {["draft", "active", "done"].map((status) => (
        <div key={status} className="w-72 shrink-0">
          <Skeleton className="h-6 w-24 mb-3" />
          <Skeleton className="h-[200px] rounded-lg" />
        </div>
      ))}
    </div>
  );
}

// List View Components

interface TasksListViewProps {
  onTaskClick: (task: Task) => void;
  onEditTask: (task: Task, workspaceId: string) => void;
  onDeleteTask: (task: Task) => void;
}

function TasksListView({
  onTaskClick,
  onEditTask,
  onDeleteTask,
}: TasksListViewProps) {
  // We fetch all tasks for all workspaces to show a unified list
  // In a real app with pagination, this might be different
  const { data: allTasks } = useQuery({
    ...taskListQuery(),
  });

  const workspaceMap = useWorkspaceMap();

  if (!allTasks) {
    return <TasksSkeleton />;
  }

  const sortedTasks = [...allTasks].sort((a, b) => {
    // Sort by status (active first)
    if (a.status === "active" && b.status !== "active") return -1;
    if (a.status !== "active" && b.status === "active") return 1;
    // Then by creation date (newest first)
    return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
  });

  return (
    <div className="border rounded-md overflow-hidden">
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-muted/50 border-b">
            <tr>
              <th className="h-10 px-4 text-left font-medium text-muted-foreground w-[30%]">
                Title
              </th>
              <th className="h-10 px-4 text-left font-medium text-muted-foreground w-[15%]">
                Workspace
              </th>
              <th className="h-10 px-4 text-left font-medium text-muted-foreground w-[10%]">
                Status
              </th>
              <th className="h-10 px-4 text-left font-medium text-muted-foreground w-[25%]">
                Progress
              </th>
              <th className="h-10 px-4 text-left font-medium text-muted-foreground w-[10%]">
                Created
              </th>
              <th className="h-10 px-4 text-right font-medium text-muted-foreground w-[10%]">
                Actions
              </th>
            </tr>
          </thead>
          <tbody>
            {sortedTasks.length === 0 ? (
              <tr>
                <td
                  colSpan={6}
                  className="h-24 text-center text-muted-foreground"
                >
                  No tasks found. Create a task in a workspace to get started.
                </td>
              </tr>
            ) : (
              sortedTasks.map((task) => (
                <TaskRow
                  key={task.id}
                  task={task}
                  workspaceName={
                    workspaceMap.get(task.workspaceId) ?? "Unknown"
                  }
                  onClick={() => onTaskClick(task)}
                  onEdit={() => onEditTask(task, task.workspaceId)}
                  onDelete={() => onDeleteTask(task)}
                />
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function TaskRow({
  task,
  workspaceName,
  onClick,
  onEdit,
  onDelete,
}: {
  task: Task;
  workspaceName: string;
  onClick: () => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const { data: sandbox } = useQuery({
    ...sandboxDetailQuery(task.data.sandboxId ?? ""),
    enabled: !!task.data.sandboxId,
  });

  const {
    totalCount,
    subsessionCount,
    completedSubsessionCount,
    progressPercent,
    aggregatedInteraction,
    needsAttention,
    hasBusySessions,
    sessionInteractions,
    todoProgress,
  } = useTaskSessionProgress(
    task,
    sandbox?.runtime?.urls?.opencode,
    sandbox
      ? {
          id: sandbox.id,
          workspaceId: sandbox.workspaceId,
        }
      : undefined,
    task.status === "active" && !!sandbox?.runtime?.urls?.opencode,
  );

  const startMutation = useStartTask();
  const completeMutation = useCompleteTask();
  const isActionPending = startMutation.isPending || completeMutation.isPending;

  const handleStart = (e: React.MouseEvent) => {
    e.stopPropagation();
    startMutation.mutate(task.id);
  };

  const handleComplete = (e: React.MouseEvent) => {
    e.stopPropagation();
    completeMutation.mutate(task.id);
  };

  const allTodos = sessionInteractions.flatMap((s) => s.todos);

  return (
    <tr
      className="border-b last:border-0 hover:bg-muted/50 cursor-pointer transition-colors group"
      onClick={onClick}
    >
      <td className="p-4 align-top">
        <div className="font-medium">{task.title}</div>
        {task.data.branchName && (
          <div className="flex items-center gap-1 mt-1 text-xs text-muted-foreground">
            <GitBranch className="h-3 w-3" />
            <span className="font-mono">{task.data.branchName}</span>
          </div>
        )}
      </td>
      <td className="p-4 align-top text-muted-foreground">{workspaceName}</td>
      <td className="p-4 align-top">
        <Badge
          variant={
            task.status === "active"
              ? "default"
              : task.status === "done"
                ? "success"
                : "secondary"
          }
        >
          {task.status}
        </Badge>
      </td>
      <td className="p-4 align-top">
        <div className="space-y-2">
          {todoProgress.total > 0 ? (
            <>
              <TodoProgressBar
                todos={allTodos}
                compact
                className="w-full max-w-[200px]"
              />
              <div className="text-xs text-muted-foreground">
                {todoProgress.completed}/{todoProgress.total} tasks
              </div>
            </>
          ) : (
            <div className="flex items-center gap-2">
              <div className="h-1.5 w-24 bg-secondary rounded-full overflow-hidden">
                <div
                  className="h-full bg-primary transition-all"
                  style={{ width: `${progressPercent}%` }}
                />
              </div>
              <span className="text-xs text-muted-foreground whitespace-nowrap">
                {completedSubsessionCount}/{totalCount + subsessionCount}{" "}
                sessions
              </span>
            </div>
          )}

          {(needsAttention ||
            hasBusySessions ||
            aggregatedInteraction.status === "busy") && (
            <div className="flex items-center gap-2">
              {hasBusySessions && (
                <Badge variant="secondary" className="text-[10px] h-5 px-1">
                  Working
                </Badge>
              )}
              <TaskSessionsStatus
                aggregatedInteraction={aggregatedInteraction}
                needsAttention={needsAttention}
                opencodeUrl={sandbox?.runtime?.urls?.opencode}
              />
            </div>
          )}
        </div>
      </td>
      <td className="p-4 align-top text-muted-foreground whitespace-nowrap">
        {formatDate(task.createdAt)}
      </td>
      <td className="p-4 align-top text-right">
        <div className="flex items-center justify-end gap-2 opacity-0 group-hover:opacity-100 transition-opacity">
          {task.status === "draft" && (
            <Button
              size="icon"
              variant="ghost"
              className="h-8 w-8 text-green-600 hover:text-green-700 hover:bg-green-50"
              onClick={handleStart}
              disabled={isActionPending}
              title="Start Task"
            >
              {startMutation.isPending ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Play className="h-4 w-4" />
              )}
            </Button>
          )}
          {task.status === "active" && (
            <Button
              size="icon"
              variant="ghost"
              className="h-8 w-8 text-green-600 hover:text-green-700 hover:bg-green-50"
              onClick={handleComplete}
              disabled={isActionPending}
              title="Complete Task"
            >
              <Archive className="h-4 w-4" />
            </Button>
          )}
          <TaskMenu
            task={task}
            onEdit={() => {
              // We need to stop propagation and call parent
              // But TaskMenu doesn't expose stopPropagation easily
              // Actually TaskMenu uses Popover which handles click
              onEdit();
            }}
            onDelete={onDelete}
            onStart={() => startMutation.mutate(task.id)}
            onComplete={() => completeMutation.mutate(task.id)}
            isActionPending={isActionPending}
          />
        </div>
      </td>
    </tr>
  );
}
