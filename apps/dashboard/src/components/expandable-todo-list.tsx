import type { Todo } from "@opencode-ai/sdk/v2";
import {
  CheckCircle,
  ChevronDown,
  ChevronRight,
  Circle,
  Loader2,
  XCircle,
} from "lucide-react";
import { useState } from "react";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";

type ExpandableTodoListProps = {
  todos: Todo[];
  sessionId: string;
  defaultExpanded?: boolean;
};

export function ExpandableTodoList({
  todos,
  sessionId,
  defaultExpanded = false,
}: ExpandableTodoListProps) {
  const [isOpen, setIsOpen] = useState(defaultExpanded);
  const [showAll, setShowAll] = useState(false);

  const completedCount = todos.filter((t) => t.status === "completed").length;
  const totalCount = todos.length;

  const displayTodos = showAll ? todos : todos.slice(0, 20);
  const remainingCount = todos.length - 20;

  if (totalCount === 0) {
    return null;
  }

  const getStatusIcon = (status: Todo["status"]) => {
    switch (status) {
      case "completed":
        return <CheckCircle className="h-4 w-4 text-green-500" />;
      case "in_progress":
        return <Loader2 className="h-4 w-4 text-blue-500 animate-spin" />;
      case "cancelled":
        return <XCircle className="h-4 w-4 text-gray-400" />;
      case "pending":
      default:
        return <Circle className="h-4 w-4 text-gray-400" />;
    }
  };

  return (
    <Collapsible open={isOpen} onOpenChange={setIsOpen} className="w-full">
      <div className="rounded-md border bg-card text-card-foreground shadow-sm">
        <CollapsibleTrigger asChild>
          <button
            type="button"
            className="flex w-full items-center justify-between p-4 hover:bg-muted/50 transition-colors"
          >
            <div className="flex items-center gap-2 font-semibold">
              <span>
                Tasks ({completedCount}/{totalCount})
              </span>
            </div>
            {isOpen ? (
              <ChevronDown className="h-4 w-4 text-muted-foreground" />
            ) : (
              <ChevronRight className="h-4 w-4 text-muted-foreground" />
            )}
          </button>
        </CollapsibleTrigger>
        <CollapsibleContent>
          <div className="border-t px-4 py-2">
            <ul className="space-y-2 py-2">
              {displayTodos.map((todo, index) => (
                <li
                  key={`${sessionId}-${index}`}
                  className="flex items-start gap-3"
                >
                  <div className="mt-0.5 shrink-0">
                    {getStatusIcon(todo.status)}
                  </div>
                  <span
                    className={cn(
                      "text-sm leading-tight",
                      todo.status === "cancelled" &&
                        "line-through text-muted-foreground",
                    )}
                  >
                    {todo.content}
                  </span>
                </li>
              ))}
            </ul>
            {!showAll && remainingCount > 0 && (
              <button
                type="button"
                onClick={() => setShowAll(true)}
                className="mt-2 w-full text-center text-sm text-muted-foreground hover:text-foreground hover:underline py-2"
              >
                Show {remainingCount} more
              </button>
            )}
          </div>
        </CollapsibleContent>
      </div>
    </Collapsible>
  );
}
