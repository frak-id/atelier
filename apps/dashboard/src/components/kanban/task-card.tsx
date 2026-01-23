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
import { opencodeSessionsQuery, sandboxDetailQuery } from "@/api/queries";
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

export function TaskCard({
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

  const { totalCount, progressPercent, completedCount } = useSubSessionProgress(
    sessions,
    task.data.opencodeSessionId,
  );

  const showConnectionInfo =
    (task.status === "in_progress" || task.status === "pending_review") &&
    sandbox?.status === "running";

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
            <button
              type="button"
              onClick={onClick}
              className="font-medium text-sm truncate text-left hover:underline"
            >
              {task.title}
            </button>
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

          {task.data.branchName && (
            <div className="flex items-center gap-1 mt-2">
              <GitBranch className="h-3 w-3 text-muted-foreground" />
              <span className="text-xs font-mono text-muted-foreground truncate">
                {task.data.branchName}
              </span>
            </div>
          )}

          {totalCount > 0 && (
            <div className="flex items-center gap-2 mt-2">
              <Progress value={progressPercent} className="flex-1 h-1.5" />
              <span className="text-xs text-muted-foreground min-w-[40px] text-right">
                {completedCount}/{totalCount}
              </span>
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
                <a
                  href={sandbox.runtime.urls.terminal}
                  target="_blank"
                  rel="noopener noreferrer"
                  title="Open Terminal"
                >
                  <Terminal className="h-3.5 w-3.5" />
                </a>
              </Button>
              <CopySshButton ssh={sandbox.runtime.urls.ssh} />
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
}

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

function CopySshButton({ ssh }: { ssh: string }) {
  const handleCopy = () => {
    navigator.clipboard.writeText(ssh);
  };

  return (
    <Button
      variant="ghost"
      size="sm"
      className="h-7 px-2 text-xs"
      onClick={handleCopy}
      title="Copy SSH command"
    >
      SSH
    </Button>
  );
}
