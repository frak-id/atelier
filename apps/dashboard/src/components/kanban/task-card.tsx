import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import type { Task } from "@frak-sandbox/manager/types";
import { useQuery } from "@tanstack/react-query";
import {
  Code,
  ExternalLink,
  GitBranch,
  GripVertical,
  MoreHorizontal,
  Terminal,
} from "lucide-react";
import { sandboxDetailQuery, sandboxGitStatusQuery } from "@/api/queries";
import { SessionStatusIndicator } from "@/components/session-status-indicator";
import { SessionTodoInfo } from "@/components/session-todo-info";
import { TodoProgressBar } from "@/components/todo-progress-bar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Progress } from "@/components/ui/progress";
import {
  type AggregatedInteractionState,
  useTaskSessionProgress,
} from "@/hooks/use-task-session-progress";
import { Link } from "@tanstack/react-router";

export type TaskCardProps = {
  task: Task;
  onClick?: () => void;
  onEdit?: () => void;
  onDelete?: () => void;
  onStart?: () => void;
  onComplete?: () => void;
  onReset?: () => void;
  isActionPending?: boolean;
};

export function TaskCard({
  task,
  onClick,
  onEdit,
  onDelete,
  onStart,
  onComplete,
  onReset,
  isActionPending,
}: TaskCardProps) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: task.id });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
  };

  const { data: sandbox } = useQuery({
    ...sandboxDetailQuery(task.data.sandboxId ?? ""),
    enabled: !!task.data.sandboxId,
  });

  const { data: gitStatus } = useQuery({
    ...sandboxGitStatusQuery(task.data.sandboxId ?? ""),
    enabled:
      !!task.data.sandboxId &&
      !!sandbox?.status &&
      sandbox.status === "running",
  });

  const isDirty =
    gitStatus?.repos?.some((r: { dirty: boolean }) => r.dirty) ?? false;
  const totalAhead =
    gitStatus?.repos?.reduce(
      (sum: number, r: { ahead: number }) => sum + r.ahead,
      0,
    ) ?? 0;

  const {
    totalCount,
    subsessionCount,
    completedSubsessionCount,
    progressPercent,
    aggregatedInteraction,
    needsAttention,
    hasBusySessions,
    isLoading: isProgressLoading,
    sessionInteractions,
    todoProgress,
    currentTask,
  } = useTaskSessionProgress(
    task,
    sandbox?.runtime?.urls?.opencode,
    sandbox
      ? {
          id: sandbox.id,
          workspaceId: sandbox.workspaceId,
        }
      : undefined,
    task.status === "active" && !!sandbox?.runtime?.urls?.opencode,
  );

  const hasActiveSessions = totalCount > 0;
  const showConnectionInfo =
    task.status === "active" && sandbox?.status === "running";
  const allTodos = sessionInteractions.flatMap((s) => s.todos);

  return (
    <div
      ref={setNodeRef}
      style={style}
      className="bg-card border rounded-lg p-3 shadow-sm hover:shadow-md transition-shadow group"
    >
      <div className="flex items-start gap-2">
        <button
          type="button"
          {...attributes}
          {...listeners}
          className="mt-1 cursor-grab active:cursor-grabbing text-muted-foreground hover:text-foreground opacity-0 group-hover:opacity-100 transition-opacity"
        >
          <GripVertical className="h-4 w-4" />
        </button>

        <div className="flex-1 min-w-0">
          <div className="flex items-start justify-between gap-2">
            <div className="flex items-center gap-1.5 min-w-0">
              <button
                type="button"
                onClick={onClick}
                className="font-medium text-sm truncate text-left hover:underline"
              >
                {task.title}
              </button>
            </div>
            <TaskMenu
              task={task}
              onEdit={onEdit}
              onDelete={onDelete}
              onStart={onStart}
              onComplete={onComplete}
              onReset={onReset}
              isActionPending={isActionPending}
            />
          </div>

          <p className="text-xs text-muted-foreground line-clamp-2 mt-1">
            {task.data.description}
          </p>

          {task.data.branchName && (
            <div className="flex items-center gap-1 mt-2">
              <GitBranch className="h-3 w-3 text-muted-foreground" />
              <span className="text-xs font-mono text-muted-foreground truncate">
                {task.data.branchName}
              </span>
              {isDirty && (
                <Badge
                  variant="destructive"
                  className="text-[9px] h-4 px-1 py-0 leading-none"
                >
                  dirty
                </Badge>
              )}
              {totalAhead > 0 && (
                <Badge
                  variant="outline"
                  className="text-[9px] h-4 px-1 py-0 leading-none font-mono"
                >
                  ↑{totalAhead}
                </Badge>
              )}
            </div>
          )}

          {task.status === "done" && sandbox && (
            <div className="flex items-center gap-1.5 mt-2">
              <Badge
                variant={sandbox.status === "running" ? "default" : "secondary"}
                className="text-[10px] h-5 px-1.5"
              >
                Sandbox {sandbox.status}
              </Badge>
            </div>
          )}

          {totalCount > 0 && (
            <div className="mt-2 space-y-1">
              {todoProgress.total > 0 ? (
                <>
                  <TodoProgressBar
                    todos={allTodos}
                    compact
                    className="flex-1"
                  />
                  {currentTask && <SessionTodoInfo todos={allTodos} compact />}
                </>
              ) : (
                <div className="flex items-center gap-2">
                  <Progress value={progressPercent} className="flex-1 h-1.5" />
                  <span className="text-xs text-muted-foreground whitespace-nowrap">
                    {completedSubsessionCount}/{totalCount + subsessionCount}
                  </span>
                </div>
              )}
            </div>
          )}

          {hasActiveSessions && !isProgressLoading && (
            <div className="flex items-center gap-2 mt-2 flex-wrap">
              {hasBusySessions && (
                <Badge variant="secondary" className="text-xs">
                  Working
                </Badge>
              )}
              <TaskSessionsStatus
                aggregatedInteraction={aggregatedInteraction}
                needsAttention={needsAttention}
              />
            </div>
          )}

          {showConnectionInfo && sandbox && (
            <div className="flex items-center gap-1 mt-2">
              <Button variant="ghost" size="sm" className="h-7 px-2" asChild>
                <a
                  href={sandbox.runtime.urls.vscode}
                  target="_blank"
                  rel="noopener noreferrer"
                  title="Open VSCode"
                >
                  <Code className="h-3.5 w-3.5" />
                </a>
              </Button>
              <Button variant="ghost" size="sm" className="h-7 px-2" asChild>
                <a
                  href={sandbox.runtime.urls.opencode}
                  target="_blank"
                  rel="noopener noreferrer"
                  title="Open OpenCode"
                >
                  <ExternalLink className="h-3.5 w-3.5" />
                </a>
              </Button>
              <Button variant="ghost" size="sm" className="h-7 px-2" asChild>
                <Link
                  to="/sandboxes/$id"
                  params={{ id: sandbox.id }}
                  search={{ tab1: "terminal" }}
                  title="Open Terminal"
                >
                  <Terminal className="h-3.5 w-3.5" />
                </Link>
              </Button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export function TaskMenu({
  task,
  onEdit,
  onDelete,
  onStart,
  onComplete,
  onReset,
  isActionPending,
}: TaskCardProps) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className="h-6 w-6 p-0 opacity-0 group-hover:opacity-100 transition-opacity"
        >
          <MoreHorizontal className="h-4 w-4" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-40 p-1" align="end">
        {task.status === "draft" && (
          <>
            <MenuButton onClick={onEdit} disabled={isActionPending}>
              Edit
            </MenuButton>
            <MenuButton onClick={onStart} disabled={isActionPending}>
              Start Task
            </MenuButton>
          </>
        )}
        {task.status === "active" && (
          <MenuButton onClick={onComplete} disabled={isActionPending}>
            Mark Complete
          </MenuButton>
        )}
        {(task.status === "active" || task.status === "done") && (
          <MenuButton onClick={onReset} disabled={isActionPending}>
            Reset to Draft
          </MenuButton>
        )}
        {(task.status === "draft" || task.status === "done") && (
          <MenuButton
            onClick={onDelete}
            disabled={isActionPending}
            className="text-destructive hover:text-destructive"
          >
            Delete
          </MenuButton>
        )}
      </PopoverContent>
    </Popover>
  );
}

function MenuButton({
  children,
  onClick,
  disabled,
  className,
}: {
  children: React.ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  className?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`w-full text-left px-2 py-1.5 text-sm rounded hover:bg-accent disabled:opacity-50 ${className ?? ""}`}
    >
      {children}
    </button>
  );
}

export function TaskSessionsStatus({
  aggregatedInteraction,
  needsAttention,
}: {
  aggregatedInteraction: AggregatedInteractionState;
  needsAttention: boolean;
}) {
  const showStatus =
    needsAttention ||
    aggregatedInteraction.status === "idle" ||
    aggregatedInteraction.status === "busy";

  if (!showStatus) {
    return null;
  }

  return <SessionStatusIndicator interaction={aggregatedInteraction} compact />;
}
