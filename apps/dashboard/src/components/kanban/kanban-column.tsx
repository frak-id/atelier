import { useDroppable } from "@dnd-kit/core";
import {
  SortableContext,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import type { Task } from "@frak/atelier-manager/types";
import { CheckCircle, Edit3, Loader2, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { TaskCard } from "./task-card";

type TaskStatus = "draft" | "active" | "done";

const statusConfig: Record<
  TaskStatus,
  {
    label: string;
    icon: React.ComponentType<{ className?: string }>;
    color: string;
  }
> = {
  draft: { label: "Draft", icon: Edit3, color: "text-muted-foreground" },
  active: { label: "Active", icon: Loader2, color: "text-blue-500" },
  done: { label: "Done", icon: CheckCircle, color: "text-green-500" },
};

type KanbanColumnProps = {
  status: TaskStatus;
  tasks: Task[];
  onCreateTask?: () => void;
  onViewTask?: (task: Task) => void;
  onEditTask?: (task: Task) => void;
  onDeleteTask?: (task: Task) => void;
  onStartTask?: (taskId: string) => void;
  onCompleteTask?: (taskId: string) => void;
  onResetTask?: (taskId: string) => void;
  isActionPending?: boolean;
};

export function KanbanColumn({
  status,
  tasks,
  onCreateTask,
  onViewTask,
  onEditTask,
  onDeleteTask,
  onStartTask,
  onCompleteTask,
  onResetTask,
  isActionPending,
}: KanbanColumnProps) {
  const { setNodeRef, isOver } = useDroppable({ id: status });
  const config = statusConfig[status];
  const Icon = config.icon;

  const sortedTasks = [...tasks].sort(
    (a, b) => (a.data.order ?? 0) - (b.data.order ?? 0),
  );

  return (
    <div className="flex flex-col w-[85vw] sm:w-72 shrink-0">
      <div className="flex items-center justify-between mb-3 px-1">
        <div className="flex items-center gap-2">
          <Icon className={`h-4 w-4 ${config.color}`} />
          <h2 className="font-semibold text-sm">{config.label}</h2>
          <span className="text-xs text-muted-foreground bg-muted px-1.5 py-0.5 rounded-full">
            {tasks.length}
          </span>
        </div>
        {status === "draft" && onCreateTask && (
          <Button
            variant="ghost"
            size="sm"
            className="h-7 w-7 p-0"
            onClick={onCreateTask}
          >
            <Plus className="h-4 w-4" />
          </Button>
        )}
      </div>

      <div
        ref={setNodeRef}
        className={`flex-1 rounded-lg p-2 min-h-[200px] transition-colors ${
          isOver ? "bg-accent/50" : "bg-muted/30"
        }`}
      >
        <SortableContext
          items={sortedTasks.map((t) => t.id)}
          strategy={verticalListSortingStrategy}
        >
          <div className="space-y-2">
            {sortedTasks.map((task) => (
              <TaskCard
                key={task.id}
                task={task}
                onClick={() => onViewTask?.(task)}
                onEdit={() => onEditTask?.(task)}
                onDelete={() => onDeleteTask?.(task)}
                onStart={() => onStartTask?.(task.id)}
                onComplete={() => onCompleteTask?.(task.id)}
                onReset={() => onResetTask?.(task.id)}
                isActionPending={isActionPending}
              />
            ))}
          </div>
        </SortableContext>

        {tasks.length === 0 && (
          <div className="flex items-center justify-center h-24 text-xs text-muted-foreground">
            {status === "draft" ? "Create a task to get started" : "No tasks"}
          </div>
        )}
      </div>
    </div>
  );
}
