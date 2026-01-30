import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import {
  Check,
  CheckCircle,
  Code,
  Copy,
  ExternalLink,
  GitBranch,
  Loader2,
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
  taskDetailQuery,
  useAddTaskSessions,
  useCompleteTask,
  useResetTask,
  useStartTask,
  workspaceDetailQuery,
} from "@/api/queries";
import { ExpandableInterventions } from "@/components/expandable-interventions";
import { TaskSessionHierarchy } from "@/components/task-session-hierarchy";
import { TodoProgressBar } from "@/components/todo-progress-bar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useTaskSessionProgress } from "@/hooks/use-task-session-progress";
import { formatDate } from "@/lib/utils";

interface TaskDrawerProps {
  taskId: string | null;
  onClose: () => void;
}

export function TaskDrawer({ taskId, onClose }: TaskDrawerProps) {
  const isOpen = !!taskId;

  const { data: taskData } = useQuery({
    ...taskDetailQuery(taskId ?? ""),
    enabled: !!taskId,
  });

  const { data: sandbox } = useQuery({
    ...sandboxDetailQuery(taskData?.data.sandboxId ?? ""),
    enabled: !!taskData?.data.sandboxId,
  });

  const { data: workspace } = useQuery({
    ...workspaceDetailQuery(taskData?.workspaceId ?? ""),
    enabled: !!taskData?.workspaceId,
  });

  const startMutation = useStartTask();
  const completeMutation = useCompleteTask();
  const resetMutation = useResetTask();

  const {
    hierarchy,
    allCount,
    totalCount,
    subsessionCount,
    completedSubsessionCount,
    progressPercent,
    sessionInteractions,
    aggregatedInteraction,
    needsAttention,
    hasBusySessions,
    todoProgress,
  } = useTaskSessionProgress(
    taskData ?? ({} as any),
    sandbox?.runtime?.urls?.opencode,
    sandbox
      ? {
          id: sandbox.id,
          workspaceId: sandbox.workspaceId,
        }
      : undefined,
    !!taskData &&
      taskData.status === "active" &&
      !!sandbox?.runtime?.urls?.opencode,
  );

  const { data: templatesData } = useQuery({
    ...globalSessionTemplatesQuery,
    enabled: taskData?.status === "active",
  });
  const secondaryTemplates =
    templatesData?.templates.filter((t) => t.category === "secondary") ?? [];

  const handleStart = () => {
    if (taskId) startMutation.mutate(taskId);
  };

  const handleComplete = () => {
    if (taskId) completeMutation.mutate(taskId);
  };

  const handleReset = () => {
    if (taskId) resetMutation.mutate(taskId);
  };

  const allTodos = sessionInteractions.flatMap((s) => s.todos);

  const statusVariant = {
    draft: "secondary",
    active: "default",
    done: "success",
  } as const;

  if (!isOpen) return null;

  return (
    <Sheet open={isOpen} onOpenChange={(open) => !open && onClose()}>
      <SheetContent
        side="right"
        className="w-[700px] sm:w-[700px] sm:max-w-none p-0 flex flex-col gap-0"
      >
        {!taskData ? (
          <div className="p-6">
            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
          </div>
        ) : (
          <>
            <SheetHeader className="p-6 border-b flex-shrink-0">
              <div className="space-y-4">
                <div className="flex items-start justify-between">
                  <div className="space-y-1">
                    <div className="flex items-center gap-2">
                      <SheetTitle className="text-xl font-bold">
                        {taskData.title}
                      </SheetTitle>
                      <Badge
                        variant={
                          statusVariant[
                            taskData.status as keyof typeof statusVariant
                          ]
                        }
                      >
                        {taskData.status}
                      </Badge>
                    </div>
                    <div className="flex items-center gap-2 text-sm text-muted-foreground">
                      {workspace && (
                        <>
                          <Link
                            to="/workspaces/$id"
                            params={{ id: workspace.id }}
                            className="hover:text-foreground transition-colors"
                            onClick={onClose}
                          >
                            {workspace.name}
                          </Link>
                          <span>•</span>
                        </>
                      )}
                      <span>Created {formatDate(taskData.createdAt)}</span>
                    </div>
                  </div>
                </div>

                <div className="flex items-center gap-2 flex-wrap">
                  {sandbox?.status === "running" && sandbox.runtime?.urls && (
                    <>
                      <Button variant="outline" size="sm" asChild>
                        <a
                          href={sandbox.runtime.urls.vscode}
                          target="_blank"
                          rel="noopener noreferrer"
                        >
                          <Code className="h-4 w-4 mr-2" />
                          VSCode
                        </a>
                      </Button>
                      <Button variant="outline" size="sm" asChild>
                        <a
                          href={sandbox.runtime.urls.opencode}
                          target="_blank"
                          rel="noopener noreferrer"
                        >
                          <ExternalLink className="h-4 w-4 mr-2" />
                          OpenCode
                        </a>
                      </Button>
                      <Button variant="outline" size="sm" asChild>
                        <a
                          href={sandbox.runtime.urls.terminal}
                          target="_blank"
                          rel="noopener noreferrer"
                        >
                          <Terminal className="h-4 w-4 mr-2" />
                          Terminal
                        </a>
                      </Button>
                      <CopySshButton ssh={sandbox.runtime.urls.ssh} />
                    </>
                  )}

                  {taskData.status === "draft" && (
                    <Button
                      onClick={handleStart}
                      disabled={startMutation.isPending}
                      size="sm"
                    >
                      {startMutation.isPending && (
                        <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                      )}
                      Start Task
                    </Button>
                  )}

                  {taskData.status === "active" && (
                    <Button
                      variant="outline"
                      onClick={handleComplete}
                      disabled={completeMutation.isPending}
                      size="sm"
                    >
                      {completeMutation.isPending ? (
                        <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                      ) : (
                        <CheckCircle className="h-4 w-4 mr-2" />
                      )}
                      Complete
                    </Button>
                  )}

                  {(taskData.status === "active" ||
                    taskData.status === "done") && (
                    <Button
                      variant="outline"
                      onClick={handleReset}
                      disabled={resetMutation.isPending}
                      size="sm"
                    >
                      {resetMutation.isPending ? (
                        <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                      ) : (
                        "Reset to Draft"
                      )}
                    </Button>
                  )}
                </div>
              </div>
            </SheetHeader>

            <ScrollArea className="flex-1">
              <div className="p-6 space-y-6">
                <Card>
                  <CardHeader>
                    <CardTitle>Description</CardTitle>
                  </CardHeader>
                  <CardContent>
                    <p className="text-sm whitespace-pre-wrap">
                      {taskData.data.description}
                    </p>
                    {taskData.data.context && (
                      <div className="mt-4 pt-4 border-t">
                        <h4 className="text-sm font-medium text-muted-foreground mb-2">
                          Additional Context
                        </h4>
                        <p className="text-sm whitespace-pre-wrap text-muted-foreground">
                          {taskData.data.context}
                        </p>
                      </div>
                    )}
                  </CardContent>
                </Card>

                {taskData.data.branchName && (
                  <Card>
                    <CardHeader>
                      <CardTitle className="flex items-center gap-2">
                        <GitBranch className="h-5 w-5" />
                        Git Status
                      </CardTitle>
                    </CardHeader>
                    <CardContent>
                      <div className="flex items-center gap-2">
                        <code className="text-sm bg-muted px-2 py-1 rounded">
                          {taskData.data.branchName}
                        </code>
                      </div>
                    </CardContent>
                  </Card>
                )}

                {totalCount > 0 && (
                  <Card>
                    <CardHeader>
                      <CardTitle>
                        Sessions
                        {subsessionCount > 0 && (
                          <span className="text-sm font-normal text-muted-foreground ml-2">
                            ({totalCount} root, {subsessionCount} sub-sessions)
                            {todoProgress.total > 0 &&
                              ` • ${todoProgress.completed}/${todoProgress.total} tasks`}
                          </span>
                        )}
                      </CardTitle>
                    </CardHeader>
                    <CardContent className="space-y-4">
                      <div className="space-y-1">
                        <div className="flex items-center gap-3">
                          <Progress
                            value={progressPercent}
                            className="flex-1 h-2"
                          />
                          <span className="text-sm text-muted-foreground whitespace-nowrap">
                            {completedSubsessionCount}/{allCount}
                          </span>
                          {hasBusySessions && (
                            <Badge variant="secondary">Working</Badge>
                          )}
                        </div>
                        {allTodos.length > 0 && (
                          <TodoProgressBar todos={allTodos} compact />
                        )}
                      </div>

                      {needsAttention && (
                        <ExpandableInterventions
                          permissions={aggregatedInteraction.pendingPermissions}
                          questions={aggregatedInteraction.pendingQuestions}
                          compact={false}
                        />
                      )}

                      <TaskSessionHierarchy
                        hierarchy={hierarchy}
                        taskSessions={taskData.data.sessions ?? []}
                        interactions={sessionInteractions}
                        opencodeUrl={sandbox?.runtime?.urls?.opencode}
                        directory={
                          sandbox?.workspaceId ?? "/home/dev/workspace"
                        }
                      />
                    </CardContent>
                  </Card>
                )}

                {taskData.status === "active" &&
                  secondaryTemplates.length > 0 && (
                    <Card>
                      <CardHeader>
                        <CardTitle>Additional Reviews</CardTitle>
                      </CardHeader>
                      <CardContent>
                        <div className="flex flex-wrap gap-2">
                          {secondaryTemplates.map((template) => (
                            <SecondaryTemplateButton
                              key={template.id}
                              template={template}
                              taskId={taskData.id}
                            />
                          ))}
                        </div>
                      </CardContent>
                    </Card>
                  )}

                <Card>
                  <CardHeader>
                    <CardTitle>Metadata</CardTitle>
                  </CardHeader>
                  <CardContent>
                    <div className="grid grid-cols-2 gap-3 text-sm">
                      <div className="text-muted-foreground">Task ID</div>
                      <code className="font-mono bg-muted px-2 py-1 rounded truncate">
                        {taskData.id}
                      </code>

                      <div className="text-muted-foreground">Status</div>
                      <Badge variant="outline" className="w-fit">
                        {taskData.status}
                      </Badge>

                      {taskData.data.sandboxId && (
                        <>
                          <div className="text-muted-foreground">
                            Sandbox ID
                          </div>
                          {sandbox ? (
                            <Link
                              to="/sandboxes/$id"
                              params={{ id: taskData.data.sandboxId }}
                              className="font-mono bg-muted px-2 py-1 rounded truncate text-blue-500 hover:underline"
                            >
                              {taskData.data.sandboxId}
                            </Link>
                          ) : (
                            <code className="font-mono bg-muted px-2 py-1 rounded truncate">
                              {taskData.data.sandboxId}
                            </code>
                          )}
                        </>
                      )}

                      {allCount > 0 && (
                        <>
                          <div className="text-muted-foreground">Sessions</div>
                          <span>{allCount} total</span>
                        </>
                      )}

                      {taskData.data.startedAt && (
                        <>
                          <div className="text-muted-foreground">Started</div>
                          <span>
                            {new Date(taskData.data.startedAt).toLocaleString()}
                          </span>
                        </>
                      )}

                      {taskData.data.completedAt && (
                        <>
                          <div className="text-muted-foreground">Completed</div>
                          <span>
                            {new Date(
                              taskData.data.completedAt,
                            ).toLocaleString()}
                          </span>
                        </>
                      )}

                      <div className="text-muted-foreground">Created</div>
                      <span>
                        {new Date(taskData.createdAt).toLocaleString()}
                      </span>

                      <div className="text-muted-foreground">Updated</div>
                      <span>
                        {new Date(taskData.updatedAt).toLocaleString()}
                      </span>
                    </div>
                  </CardContent>
                </Card>
              </div>
            </ScrollArea>
          </>
        )}
      </SheetContent>
    </Sheet>
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
      variant="outline"
      size="sm"
      className="h-9 px-3 text-sm gap-2"
      onClick={handleCopy}
      title="Copy SSH command"
    >
      {copied ? (
        <Check className="h-4 w-4 text-green-500" />
      ) : (
        <Copy className="h-4 w-4" />
      )}
      SSH
    </Button>
  );
}

type SecondaryTemplate = {
  id: string;
  name: string;
  description?: string;
};

const TEMPLATE_ICONS: Record<string, React.ReactNode> = {
  "best-practices": <CheckCircle className="h-4 w-4" />,
  "security-review": <Shield className="h-4 w-4" />,
  simplification: <Zap className="h-4 w-4" />,
};

function SecondaryTemplateButton({
  template,
  taskId,
}: {
  template: SecondaryTemplate;
  taskId: string;
}) {
  const addSessionsMutation = useAddTaskSessions();
  const icon = TEMPLATE_ICONS[template.id] ?? <Sparkles className="h-4 w-4" />;
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
          className="gap-2"
          onClick={handleSpawn}
          disabled={addSessionsMutation.isPending}
        >
          {addSessionsMutation.isPending ? (
            <Loader2 className="h-4 w-4 animate-spin" />
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
