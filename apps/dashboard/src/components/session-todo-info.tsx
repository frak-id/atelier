import type { Todo } from "@opencode-ai/sdk/v2";
import { cn } from "@/lib/utils";

type SessionTodoInfoProps = {
  todos: Todo[];
  compact?: boolean;
  className?: string;
};

export function SessionTodoInfo({
  todos,
  compact = false,
  className,
}: SessionTodoInfoProps) {
  const currentTodo = todos.find((t) => t.status === "in_progress");

  if (!currentTodo) {
    return null;
  }

  const maxLength = compact ? 50 : 100;
  const displayContent =
    currentTodo.content.length > maxLength
      ? `${currentTodo.content.slice(0, maxLength)}...`
      : currentTodo.content;

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
}
