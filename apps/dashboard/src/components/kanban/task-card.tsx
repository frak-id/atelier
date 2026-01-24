import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import type { Task } from "@frak-sandbox/manager/types";
import { useQuery } from "@tanstack/react-query";
import {
  AlertCircle,
  CheckCircle2,
  Code,
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
import {
  globalSessionTemplatesQuery,
  sandboxDetailQuery,
  useAddTaskSessions,
  useTaskInteractionState,
} from "@/api/queries";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Progress } from "@/components/ui/progress";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";

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

  const { data: interactionState } = useTaskInteractionState(
    task.id,
    task.status === "active",
  );
  const needsAttention = interactionState?.needsAttention ?? false;

  const { data: templatesData } = useQuery({
    ...globalSessionTemplatesQuery,
    enabled: task.status === "active",
  });
  const secondaryTemplates =
    templatesData?.templates.filter((t) => t.category === "secondary") ?? [];

  const addSessionsMutation = useAddTaskSessions();

  const sessions = task.data.sessions ?? [];
  const completedSessions = sessions.filter((s) => s.status === "completed");
  const runningSessions = sessions.filter((s) => s.status === "running");
  const totalCount = sessions.length;
  const progressPercent =
    totalCount > 0
      ? Math.round((completedSessions.length / totalCount) * 100)
      : 0;

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
              {needsAttention && interactionState && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <AlertCircle className="h-4 w-4 text-amber-500 shrink-0 cursor-help" />
                  </TooltipTrigger>
                  <TooltipContent>
                    <NeedsAttentionTooltip
                      interactionState={interactionState}
                    />
                  </TooltipContent>
                </Tooltip>
              )}
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
              <Progress value={progressPercent} className="flex-1 h-1.5" />
              <span className="text-xs text-muted-foreground min-w-[40px] text-right">
                {completedSessions.length}/{totalCount}
              </span>
            </div>
          )}

          {runningSessions.length > 0 && (
            <Badge variant="secondary" className="mt-2 text-xs">
              {runningSessions.length} session
              {runningSessions.length > 1 ? "s" : ""} running
            </Badge>
          )}

          {task.status === "active" &&
            sessions.length > 0 &&
            secondaryTemplates.length > 0 && (
              <div className="flex flex-wrap gap-1 mt-2">
                {secondaryTemplates.map((template) => (
                  <SecondaryTemplateButton
                    key={template.id}
                    template={template}
                    isPending={addSessionsMutation.isPending}
                    onSpawn={() =>
                      addSessionsMutation.mutate({
                        id: task.id,
                        sessionTemplateIds: [template.id],
                      })
                    }
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

type InteractionState = {
  sessions: Array<{
    sessionId: string;
    pendingPermissions: Array<{ permission: string }>;
    pendingQuestions: Array<{ question: string }>;
  }>;
};

function NeedsAttentionTooltip({
  interactionState,
}: {
  interactionState: InteractionState;
}) {
  const permissionCount = interactionState.sessions.reduce(
    (acc, s) => acc + s.pendingPermissions.length,
    0,
  );
  const questionCount = interactionState.sessions.reduce(
    (acc, s) => acc + s.pendingQuestions.length,
    0,
  );

  const items: string[] = [];
  if (permissionCount > 0) {
    items.push(
      `${permissionCount} permission${permissionCount > 1 ? "s" : ""} pending`,
    );
  }
  if (questionCount > 0) {
    items.push(
      `${questionCount} question${questionCount > 1 ? "s" : ""} pending`,
    );
  }

  return <span>{items.join(", ") || "Needs attention"}</span>;
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
  isPending,
  onSpawn,
}: {
  template: SecondaryTemplate;
  isPending: boolean;
  onSpawn: () => void;
}) {
  const icon = TEMPLATE_ICONS[template.id] ?? <Sparkles className="h-3 w-3" />;
  const shortName = template.name.replace(" Review", "").replace("ation", "");

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          className="h-6 px-2 text-xs gap-1"
          onClick={onSpawn}
          disabled={isPending}
        >
          {isPending ? <Loader2 className="h-3 w-3 animate-spin" /> : icon}
          {shortName}
        </Button>
      </TooltipTrigger>
      <TooltipContent>
        <span>{template.description ?? template.name}</span>
      </TooltipContent>
    </Tooltip>
  );
}
