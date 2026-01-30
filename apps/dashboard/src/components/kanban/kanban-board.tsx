import {
  closestCorners,
  DndContext,
  type DragEndEvent,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import { sortableKeyboardCoordinates } from "@dnd-kit/sortable";
import type { Task } from "@frak-sandbox/manager/types";
import { useMemo, useState } from "react";
import {
  useCompleteTask,
  useReorderTask,
  useResetTask,
  useStartTask,
} from "@/api/queries";
import { KanbanColumn } from "./kanban-column";

type TaskStatus = "draft" | "active" | "done";

const STATUSES: TaskStatus[] = ["draft", "active", "done"];

type KanbanBoardProps = {
  tasks: Task[];
  onCreateTask: () => void;
  onTaskClick: (task: Task) => void;
  onEditTask: (task: Task) => void;
  onDeleteTask: (task: Task) => void;
};

export function KanbanBoard({
  tasks,
  onCreateTask,
  onTaskClick,
  onEditTask,
  onDeleteTask,
}: KanbanBoardProps) {
  const [isActionPending, setIsActionPending] = useState(false);

  const startMutation = useStartTask();
  const completeMutation = useCompleteTask();
  const resetMutation = useResetTask();
  const reorderMutation = useReorderTask();

  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: {
        distance: 8,
      },
    }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    }),
  );

  const tasksByStatus = useMemo(() => {
    const grouped: Record<TaskStatus, Task[]> = {
      draft: [],
      active: [],
      done: [],
    };

    for (const task of tasks) {
      const status = task.status as TaskStatus;
      if (grouped[status]) {
        grouped[status].push(task);
      }
    }

    return grouped;
  }, [tasks]);

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    if (!over) return;

    const taskId = active.id as string;
    const task = tasks.find((t) => t.id === taskId);
    if (!task) return;

    const targetStatus = over.id as TaskStatus;

    if (STATUSES.includes(targetStatus) && task.status !== targetStatus) {
      handleStatusChange(taskId, task.status as TaskStatus, targetStatus);
    } else if (active.id !== over.id) {
      const targetTask = tasks.find((t) => t.id === over.id);
      if (targetTask) {
        reorderMutation.mutate({
          id: taskId,
          order: targetTask.data.order ?? 0,
        });
      }
    }
  };

  const handleStatusChange = (
    taskId: string,
    fromStatus: TaskStatus,
    toStatus: TaskStatus,
  ) => {
    if (fromStatus === "draft" && toStatus === "active") {
      handleStartTask(taskId);
    } else if (fromStatus === "active" && toStatus === "done") {
      handleCompleteTask(taskId);
    } else if (toStatus === "draft") {
      handleResetTask(taskId);
    }
  };

  const handleStartTask = async (taskId: string) => {
    setIsActionPending(true);
    try {
      await startMutation.mutateAsync(taskId);
    } finally {
      setIsActionPending(false);
    }
  };

  const handleCompleteTask = async (taskId: string) => {
    setIsActionPending(true);
    try {
      await completeMutation.mutateAsync(taskId);
    } finally {
      setIsActionPending(false);
    }
  };

  const handleResetTask = async (taskId: string) => {
    setIsActionPending(true);
    try {
      await resetMutation.mutateAsync(taskId);
    } finally {
      setIsActionPending(false);
    }
  };

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCorners}
      onDragEnd={handleDragEnd}
    >
      <div className="flex gap-4 overflow-x-auto pb-4">
        {STATUSES.map((status) => (
          <KanbanColumn
            key={status}
            status={status}
            tasks={tasksByStatus[status]}
            onCreateTask={status === "draft" ? onCreateTask : undefined}
            onViewTask={onTaskClick}
            onEditTask={onEditTask}
            onDeleteTask={onDeleteTask}
            onStartTask={handleStartTask}
            onCompleteTask={handleCompleteTask}
            onResetTask={handleResetTask}
            isActionPending={isActionPending}
          />
        ))}
      </div>
    </DndContext>
  );
}
