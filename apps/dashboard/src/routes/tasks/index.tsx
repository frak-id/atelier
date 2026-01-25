import type { Task } from "@frak-sandbox/manager/types";
import { useQuery, useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { Suspense, useState } from "react";
import { taskListQuery, workspaceListQuery } from "@/api/queries";
import {
  KanbanBoard,
  TaskDeleteDialog,
  TaskFormDialog,
} from "@/components/kanban";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";

export const Route = createFileRoute("/tasks/")({
  component: TasksPage,
  loader: ({ context }) => {
    context.queryClient.ensureQueryData(workspaceListQuery());
  },
  pendingComponent: TasksSkeleton,
});

function TasksPage() {
  const navigate = useNavigate();
  const { data: workspaces } = useSuspenseQuery(workspaceListQuery());
  const workspaceList = workspaces ?? [];
  const [selectedWorkspaceId, setSelectedWorkspaceId] = useState<string>(
    workspaceList[0]?.id ?? "",
  );

  const [isFormOpen, setIsFormOpen] = useState(false);
  const [editingTask, setEditingTask] = useState<Task | undefined>();
  const [deletingTask, setDeletingTask] = useState<Task | null>(null);

  const { data: tasks } = useQuery({
    ...taskListQuery(selectedWorkspaceId),
    enabled: !!selectedWorkspaceId,
  });
  const taskList = tasks ?? [];

  const handleCreateTask = () => {
    setEditingTask(undefined);
    setIsFormOpen(true);
  };

  const handleEditTask = (task: Task) => {
    setEditingTask(task);
    setIsFormOpen(true);
  };

  const handleDeleteTask = (task: Task) => {
    setDeletingTask(task);
  };

  const handleViewTask = (task: Task) => {
    navigate({ to: "/tasks/$id", params: { id: task.id } });
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
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold sm:text-3xl">Tasks</h1>
          <p className="text-muted-foreground">
            Manage AI coding tasks with a kanban board
          </p>
        </div>

        <Select
          value={selectedWorkspaceId}
          onValueChange={setSelectedWorkspaceId}
        >
          <SelectTrigger className="w-[200px]">
            <SelectValue placeholder="Select workspace" />
          </SelectTrigger>
          <SelectContent>
            {workspaceList.map((workspace) => (
              <SelectItem key={workspace.id} value={workspace.id}>
                {workspace.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <Suspense fallback={<KanbanSkeleton />}>
        <KanbanBoard
          tasks={taskList}
          onCreateTask={handleCreateTask}
          onViewTask={handleViewTask}
          onEditTask={handleEditTask}
          onDeleteTask={handleDeleteTask}
        />
      </Suspense>

      <TaskFormDialog
        open={isFormOpen}
        onOpenChange={setIsFormOpen}
        workspaceId={selectedWorkspaceId}
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

function TasksSkeleton() {
  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <Skeleton className="h-9 w-32" />
          <Skeleton className="h-4 w-64 mt-2" />
        </div>
        <Skeleton className="h-10 w-[200px]" />
      </div>
      <KanbanSkeleton />
    </div>
  );
}

const SKELETON_COLUMNS = ["draft", "active", "done"];

function KanbanSkeleton() {
  return (
    <div className="flex gap-4 overflow-x-auto pb-4">
      {SKELETON_COLUMNS.map((status) => (
        <div key={status} className="w-72 shrink-0">
          <Skeleton className="h-6 w-24 mb-3" />
          <Skeleton className="h-[200px] rounded-lg" />
        </div>
      ))}
    </div>
  );
}
