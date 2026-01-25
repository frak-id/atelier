import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import type { Task } from "@frak-sandbox/manager/types";
import { useQuery } from "@tanstack/react-query";
import {
  Check,
  CheckCircle2,
  Code,
  Copy,
  ExternalLink,
  GitBranch,
  GripVertical,
  Loader2,
  MoreHorizontal,
  Shield,
  Sparkles,
  Terminal,
  Zap,
} from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import {
  globalSessionTemplatesQuery,
  sandboxDetailQuery,
  useAddTaskSessions,
} from "@/api/queries";
import { ExpandableInterventions } from "@/components/expandable-interventions";
import { SessionStatusIndicator } from "@/components/session-status-indicator";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  type AggregatedInteractionState,
  useTaskSessionProgress,
} from "@/hooks/use-task-session-progress";

type TaskCardProps = {
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

  const {
    totalCount,
    subsessionCount,
    aggregatedInteraction,
    needsAttention,
    hasBusySessions,
    isLoading: isProgressLoading,
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

  const { data: templatesData } = useQuery({
    ...globalSessionTemplatesQuery,
    enabled: task.status === "active",
  });
  const secondaryTemplates =
    templatesData?.templates.filter((t) => t.category === "secondary") ?? [];

  const hasActiveSessions = totalCount > 0;
  const showConnectionInfo =
    task.status === "active" && sandbox?.status === "running";

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
            </div>
          )}

          {totalCount > 0 && (
            <div className="flex items-center gap-2 mt-2">
              <div className="flex flex-col items-end gap-0.5">
                <span className="text-xs text-muted-foreground">
                  {totalCount} session{totalCount !== 1 ? "s" : ""}
                </span>
                {subsessionCount > 0 && (
                  <span className="text-xs text-muted-foreground">
                    (+{subsessionCount} sub)
                  </span>
                )}
              </div>
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
                opencodeUrl={sandbox?.runtime?.urls?.opencode}
              />
            </div>
          )}

          {task.status === "active" &&
            hasActiveSessions &&
            secondaryTemplates.length > 0 && (
              <div className="flex flex-wrap gap-1 mt-2">
                {secondaryTemplates.map((template) => (
                  <SecondaryTemplateButton
                    key={template.id}
                    template={template}
                    taskId={task.id}
                  />
                ))}
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
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(ssh);
      setCopied(true);
      toast.success("SSH command copied to clipboard");
      setTimeout(() => setCopied(false), 2000);
    } catch {
      toast.error("Failed to copy SSH command", {
        description: "Your browser may not support clipboard access",
      });
    }
  };

  return (
    <Button
      variant="ghost"
      size="sm"
      className="h-7 px-2 text-xs gap-1"
      onClick={handleCopy}
      title="Copy SSH command"
    >
      {copied ? (
        <Check className="h-3 w-3 text-green-500" />
      ) : (
        <Copy className="h-3 w-3" />
      )}
      SSH
    </Button>
  );
}

function TaskSessionsStatus({
  aggregatedInteraction,
  needsAttention,
  opencodeUrl,
}: {
  aggregatedInteraction: AggregatedInteractionState;
  needsAttention: boolean;
  opencodeUrl: string | undefined;
}) {
  const showStatus =
    needsAttention ||
    aggregatedInteraction.status === "idle" ||
    aggregatedInteraction.status === "busy";

  if (!showStatus) {
    return null;
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <SessionStatusIndicator interaction={aggregatedInteraction} compact />
        {needsAttention && opencodeUrl && (
          <Button
            variant="outline"
            size="sm"
            className="h-6 text-xs gap-1"
            asChild
          >
            <a href={opencodeUrl} target="_blank" rel="noopener noreferrer">
              <ExternalLink className="h-3 w-3" />
              Respond
            </a>
          </Button>
        )}
      </div>
      <ExpandableInterventions
        permissions={aggregatedInteraction.pendingPermissions}
        questions={aggregatedInteraction.pendingQuestions}
        compact={true}
      />
    </div>
  );
}

type SecondaryTemplate = {
  id: string;
  name: string;
  description?: string;
};

const TEMPLATE_ICONS: Record<string, React.ReactNode> = {
  "best-practices": <CheckCircle2 className="h-3 w-3" />,
  "security-review": <Shield className="h-3 w-3" />,
  simplification: <Zap className="h-3 w-3" />,
};

function SecondaryTemplateButton({
  template,
  taskId,
}: {
  template: SecondaryTemplate;
  taskId: string;
}) {
  const addSessionsMutation = useAddTaskSessions();
  const icon = TEMPLATE_ICONS[template.id] ?? <Sparkles className="h-3 w-3" />;
  const shortName = template.name.replace(" Review", "").replace("ation", "");

  const handleSpawn = () => {
    addSessionsMutation.mutate(
      { id: taskId, sessionTemplateIds: [template.id] },
      {
        onSuccess: () => {
          toast.success(`${template.name} session started`);
        },
        onError: (error) => {
          toast.error(`Failed to start ${template.name}`, {
            description:
              error instanceof Error ? error.message : "Unknown error",
          });
        },
      },
    );
  };

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          className="h-6 px-2 text-xs gap-1"
          onClick={handleSpawn}
          disabled={addSessionsMutation.isPending}
        >
          {addSessionsMutation.isPending ? (
            <Loader2 className="h-3 w-3 animate-spin" />
          ) : (
            icon
          )}
          {shortName}
        </Button>
      </TooltipTrigger>
      <TooltipContent>
        <span>{template.description ?? template.name}</span>
      </TooltipContent>
    </Tooltip>
  );
}
