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
  useMoveTaskToReview,
  useReorderTask,
  useResetTask,
  useStartTask,
} from "@/api/queries";
import { KanbanColumn } from "./kanban-column";

type TaskStatus =
  | "draft"
  | "queue"
  | "in_progress"
  | "pending_review"
  | "completed";

const STATUSES: TaskStatus[] = [
  "draft",
  "queue",
  "in_progress",
  "pending_review",
  "completed",
];

type KanbanBoardProps = {
  tasks: Task[];
  onCreateTask: () => void;
  onViewTask: (task: Task) => void;
  onEditTask: (task: Task) => void;
  onDeleteTask: (task: Task) => void;
};

export function KanbanBoard({
  tasks,
  onCreateTask,
  onViewTask,
  onEditTask,
  onDeleteTask,
}: KanbanBoardProps) {
  const [isActionPending, setIsActionPending] = useState(false);

  const startMutation = useStartTask();
  const reviewMutation = useMoveTaskToReview();
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
      queue: [],
      in_progress: [],
      pending_review: [],
      completed: [],
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
    if (fromStatus === "draft" && toStatus === "queue") {
      handleStartTask(taskId);
    } else if (fromStatus === "in_progress" && toStatus === "pending_review") {
      handleReviewTask(taskId);
    } else if (fromStatus === "pending_review" && toStatus === "completed") {
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

  const handleReviewTask = async (taskId: string) => {
    setIsActionPending(true);
    try {
      await reviewMutation.mutateAsync(taskId);
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
            onViewTask={onViewTask}
            onEditTask={onEditTask}
            onDeleteTask={onDeleteTask}
            onStartTask={handleStartTask}
            onReviewTask={handleReviewTask}
            onCompleteTask={handleCompleteTask}
            onResetTask={handleResetTask}
            isActionPending={isActionPending}
          />
        ))}
      </div>
    </DndContext>
  );
}
