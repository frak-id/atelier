import type { Todo } from "@opencode-ai/sdk/v2";
import { memo, useMemo } from "react";
import { cn } from "@/lib/utils";

type SessionTodoInfoProps = {
  todos: Todo[];
  compact?: boolean;
  className?: string;
};

export const SessionTodoInfo = memo(function SessionTodoInfo({
  todos,
  compact = false,
  className,
}: SessionTodoInfoProps) {
  const currentTodo = useMemo(
    () => todos.find((t) => t.status === "in_progress"),
    [todos],
  );

  const displayContent = useMemo(() => {
    if (!currentTodo) return null;
    const maxLength = compact ? 50 : 100;
    return currentTodo.content.length > maxLength
      ? `${currentTodo.content.slice(0, maxLength)}...`
      : currentTodo.content;
  }, [currentTodo, compact]);

  if (!currentTodo) {
    return null;
  }

  return (
    <div
      className={cn(
        "text-muted-foreground italic truncate",
        compact ? "text-xs" : "text-sm",
        className,
      )}
    >
      Working on: {displayContent}
    </div>
  );
});
