import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import type { Task } from "@frak-sandbox/manager/types";
import { useQuery } from "@tanstack/react-query";
import { GitBranch, GripVertical, MoreHorizontal } from "lucide-react";
import { memo } from "react";
import { opencodeSessionsQuery, sandboxDetailQuery } from "@/api/queries";
import { QuickActions } from "@/components/shared/quick-actions";
import {
  type IndicatorStatus,
  StatusIndicator,
} from "@/components/shared/status-indicator";
import { TimeAgo } from "@/components/shared/time-ago";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Progress } from "@/components/ui/progress";
import { useSubSessionProgress } from "./task-detail-dialog";

type TaskCardProps = {
  task: Task;
  onClick?: () => void;
  onEdit?: () => void;
  onDelete?: () => void;
  onStart?: () => void;
  onReview?: () => void;
  onComplete?: () => void;
  onReset?: () => void;
  isActionPending?: boolean;
};

function getTaskStatusIndicator(task: Task): IndicatorStatus {
  switch (task.status) {
    case "draft":
      return "draft";
    case "queue":
      return "queued";
    case "in_progress":
      return "running";
    case "pending_review":
      return "review";
    case "completed":
      return "complete";
    default:
      return "idle";
  }
}

export const TaskCard = memo(function TaskCard({
  task,
  onClick,
  onEdit,
  onDelete,
  onStart,
  onReview,
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

  const opencodeUrl = sandbox?.runtime?.urls?.opencode
    ? new URL(sandbox.runtime.urls.opencode).origin
    : null;

  const { data: sessions } = useQuery({
    ...opencodeSessionsQuery(opencodeUrl ?? ""),
    enabled: !!opencodeUrl,
  });

  const isTaskInProgress = task.status === "in_progress";
  const { totalCount, progressPercent, completedCount } = useSubSessionProgress(
    sessions,
    task.data.opencodeSessionId,
    isTaskInProgress,
  );

  const showConnectionInfo =
    (task.status === "in_progress" || task.status === "pending_review") &&
    sandbox?.status === "running";

  const statusIndicator = getTaskStatusIndicator(task);
  const needsAttention = task.status === "pending_review";

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={`bg-card border rounded-lg p-3 shadow-sm hover:shadow-md transition-shadow group ${
        needsAttention ? "border-amber-500/50" : ""
      }`}
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
            <div className="flex items-center gap-2 min-w-0">
              <StatusIndicator
                status={statusIndicator}
                size="sm"
                pulse={task.status === "in_progress"}
              />
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
              onReview={onReview}
              onComplete={onComplete}
              onReset={onReset}
              isActionPending={isActionPending}
            />
          </div>

          <p className="text-xs text-muted-foreground line-clamp-2 mt-1">
            {task.data.description}
          </p>

          <div className="flex items-center gap-2 mt-2 text-xs text-muted-foreground">
            {task.data.branchName && (
              <div className="flex items-center gap-1">
                <GitBranch className="h-3 w-3" />
                <span className="font-mono truncate max-w-[100px]">
                  {task.data.branchName}
                </span>
              </div>
            )}
            <TimeAgo date={task.updatedAt} className="ml-auto" />
          </div>

          {totalCount > 0 && (
            <div className="flex items-center gap-2 mt-2">
              <Progress value={progressPercent} className="flex-1 h-1.5" />
              <span className="text-xs text-muted-foreground min-w-[40px] text-right">
                {completedCount}/{totalCount}
              </span>
            </div>
          )}

          {showConnectionInfo && sandbox && (
            <div className="mt-2">
              <QuickActions
                vscodeUrl={sandbox.runtime.urls.vscode}
                terminalUrl={sandbox.runtime.urls.terminal}
                opencodeUrl={sandbox.runtime.urls.opencode}
                sshCommand={sandbox.runtime.urls.ssh}
              />
            </div>
          )}

          {task.status === "queue" && (
            <Badge variant="secondary" className="mt-2 text-xs">
              Waiting to start...
            </Badge>
          )}
        </div>
      </div>
    </div>
  );
});

function TaskMenu({
  task,
  onEdit,
  onDelete,
  onStart,
  onReview,
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
        {task.status === "in_progress" && (
          <MenuButton onClick={onReview} disabled={isActionPending}>
            Move to Review
          </MenuButton>
        )}
        {task.status === "pending_review" && (
          <MenuButton onClick={onComplete} disabled={isActionPending}>
            Mark Complete
          </MenuButton>
        )}
        {(task.status === "in_progress" ||
          task.status === "pending_review" ||
          task.status === "completed") && (
          <MenuButton onClick={onReset} disabled={isActionPending}>
            Reset to Draft
          </MenuButton>
        )}
        <MenuButton
          onClick={onDelete}
          disabled={isActionPending}
          className="text-destructive hover:text-destructive"
        >
          Delete
        </MenuButton>
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
