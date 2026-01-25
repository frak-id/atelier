import type { Task } from "@frak-sandbox/manager/types";
import { useQuery, useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { ChevronDown, ChevronRight } from "lucide-react";
import { Suspense, useState } from "react";
import { taskListQuery, workspaceListQuery } from "@/api/queries";
import {
  KanbanBoard,
  TaskDeleteDialog,
  TaskDetailDialog,
  TaskFormDialog,
} from "@/components/kanban";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";

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

  const [isFormOpen, setIsFormOpen] = useState(false);
  const [editingTask, setEditingTask] = useState<Task | undefined>();
  const [activeWorkspaceId, setActiveWorkspaceId] = useState<string>("");
  const [deletingTask, setDeletingTask] = useState<Task | null>(null);
  const [viewingTask, setViewingTask] = useState<Task | null>(null);

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

  const handleViewTask = (task: Task) => {
    setViewingTask(task);
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
      <div>
        <h1 className="text-2xl font-bold sm:text-3xl">Tasks</h1>
        <p className="text-muted-foreground">
          Manage AI coding tasks with kanban boards per workspace
        </p>
      </div>

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
                      onViewTask={handleViewTask}
                      onEditTask={(task) => handleEditTask(task, workspace.id)}
                      onDeleteTask={handleDeleteTask}
                    />
                  </Suspense>
                </div>
              )}
            </section>
          );
        })}
      </div>

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

      <TaskDetailDialog
        open={!!viewingTask}
        onOpenChange={(open) => !open && setViewingTask(null)}
        task={viewingTask}
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
  onViewTask: (task: Task) => void;
  onEditTask: (task: Task) => void;
  onDeleteTask: (task: Task) => void;
}

function WorkspaceKanban({
  workspaceId,
  onCreateTask,
  onViewTask,
  onEditTask,
  onDeleteTask,
}: WorkspaceKanbanProps) {
  const { data: tasks } = useSuspenseQuery(taskListQuery(workspaceId));
  const taskList = tasks ?? [];

  return (
    <KanbanBoard
      tasks={taskList}
      onCreateTask={onCreateTask}
      onViewTask={onViewTask}
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
