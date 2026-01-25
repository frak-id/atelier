import type { Todo } from "@opencode-ai/sdk/v2";
import { memo, useMemo } from "react";
import { cn } from "@/lib/utils";

type TodoProgressBarProps = {
  todos: Todo[];
  compact?: boolean;
  className?: string;
};

export const TodoProgressBar = memo(function TodoProgressBar({
  todos,
  compact = false,
  className,
}: TodoProgressBarProps) {
  const { completed, inProgress, pending, total } = useMemo(() => {
    let c = 0;
    let ip = 0;
    let p = 0;
    for (const t of todos) {
      if (t.status === "completed") c++;
      else if (t.status === "in_progress") ip++;
      else if (t.status === "pending") p++;
    }
    return { completed: c, inProgress: ip, pending: p, total: c + ip + p };
  }, [todos]);

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
});
