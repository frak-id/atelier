import type { Todo } from "@opencode-ai/sdk/v2";
import { cn } from "@/lib/utils";

type TodoProgressBarProps = {
  todos: Todo[];
  compact?: boolean;
  className?: string;
};

export function TodoProgressBar({
  todos,
  compact = false,
  className,
}: TodoProgressBarProps) {
  const completed = todos.filter((t) => t.status === "completed").length;
  const inProgress = todos.filter((t) => t.status === "in_progress").length;
  const pending = todos.filter((t) => t.status === "pending").length;
  const total = completed + inProgress + pending;

  if (total === 0) {
    return null;
  }

  const completedPercent = (completed / total) * 100;
  const inProgressPercent = (inProgress / total) * 100;
  const pendingPercent = (pending / total) * 100;

  return (
    <div className={cn("w-full space-y-1", className)}>
      <div
        className={cn(
          "flex w-full overflow-hidden rounded-full bg-secondary",
          compact ? "h-1.5" : "h-2",
        )}
      >
        {completed > 0 && (
          <div
            className="bg-green-500"
            style={{ width: `${completedPercent}%` }}
          />
        )}
        {inProgress > 0 && (
          <div
            className="bg-blue-500"
            style={{ width: `${inProgressPercent}%` }}
          />
        )}
        {pending > 0 && (
          <div
            className="bg-gray-300"
            style={{ width: `${pendingPercent}%` }}
          />
        )}
      </div>
      <div className="flex justify-end text-[10px] text-muted-foreground">
        {completed}/{total}
      </div>
    </div>
  );
}
