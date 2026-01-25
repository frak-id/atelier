import { useQuery, useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import {
  ArrowLeft,
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
  Trash2,
  Zap,
} from "lucide-react";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import {
  globalSessionTemplatesQuery,
  sandboxDetailQuery,
  taskDetailQuery,
  useAddTaskSessions,
  useCompleteTask,
  useDeleteTask,
  useResetTask,
} from "@/api/queries";
import { ExpandableInterventions } from "@/components/expandable-interventions";
import { TaskSessionHierarchy } from "@/components/task-session-hierarchy";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useOpencodeInteraction } from "@/hooks/use-opencode-interaction";
import { useTaskSessionHierarchy } from "@/hooks/use-task-session-hierarchy";
import { useTaskSessionProgress } from "@/hooks/use-task-session-progress";

export const Route = createFileRoute("/tasks/$id")({
  component: TaskDetailPage,
  loader: ({ context, params }) => {
    context.queryClient.ensureQueryData(taskDetailQuery(params.id));
  },
  pendingComponent: () => (
    <div className="p-6 space-y-6">
      <Skeleton className="h-8 w-64" />
      <Skeleton className="h-64" />
    </div>
  ),
});

function TaskDetailPage() {
  const { id } = Route.useParams();
  const navigate = useNavigate();
  const { data: taskData } = useSuspenseQuery(taskDetailQuery(id));

  const task = taskData!;

  const deleteMutation = useDeleteTask();
  const completeMutation = useCompleteTask();
  const resetMutation = useResetTask();

  const { data: sandbox } = useQuery({
    ...sandboxDetailQuery(task.data.sandboxId ?? ""),
    enabled: !!task.data.sandboxId,
  });

  const { hierarchy, allSessions } = useTaskSessionHierarchy(
    task,
    sandbox?.runtime.urls.opencode,
    sandbox
      ? {
          id: sandbox.id,
          workspaceId: sandbox.workspaceId,
        }
      : undefined,
  );

  const {
    sessions,
    totalCount,
    completedCount,
    runningCount,
    progressPercent,
    hasRunningSessions,
  } = useTaskSessionProgress(task);

  const sessionIds = useMemo(() => sessions.map((s) => s.id), [sessions]);

  const interactionState = useOpencodeInteraction(
    sandbox?.runtime?.urls?.opencode,
    sessionIds,
    task.status === "active" && !!sandbox?.runtime?.urls?.opencode,
  );

  const { data: templatesData } = useQuery({
    ...globalSessionTemplatesQuery,
    enabled: task.status === "active",
  });
  const secondaryTemplates =
    templatesData?.templates.filter((t) => t.category === "secondary") ?? [];

  // Aggregate permissions and questions from all sessions
  const allPermissions = interactionState.sessions.flatMap((s) =>
    s.pendingPermissions.map((p) => ({ ...p, sessionId: s.sessionId })),
  );
  const allQuestions = interactionState.sessions.flatMap((s) =>
    s.pendingQuestions.map((q) => ({ ...q, sessionId: s.sessionId })),
  );

  const handleDelete = () => {
    if (confirm(`Delete task "${task.title}"?`)) {
      deleteMutation.mutate(
        { id, keepSandbox: false },
        {
          onSuccess: () => navigate({ to: "/tasks" }),
        },
      );
    }
  };

  const handleComplete = () => {
    completeMutation.mutate(id);
  };

  const handleReset = () => {
    resetMutation.mutate(id);
  };

  const statusVariant = {
    draft: "secondary",
    active: "default",
    done: "success",
  } as const;

  return (
    <div className="p-6 space-y-6">
      <div className="space-y-4">
        <div className="flex items-center gap-4">
          <Button variant="ghost" size="icon" asChild>
            <Link to="/tasks">
              <ArrowLeft className="h-4 w-4" />
            </Link>
          </Button>
          <div className="flex items-center gap-3">
            <h1 className="text-3xl font-bold">{task.title}</h1>
            <Badge
              variant={statusVariant[task.status as keyof typeof statusVariant]}
            >
              {task.status}
            </Badge>
          </div>
        </div>

        <p className="text-muted-foreground">
          Created {new Date(task.createdAt).toLocaleString()}
        </p>

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

          {task.status === "active" && (
            <Button
              variant="outline"
              onClick={handleComplete}
              disabled={completeMutation.isPending}
            >
              {completeMutation.isPending ? (
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
              ) : (
                <CheckCircle className="h-4 w-4 mr-2" />
              )}
              Complete
            </Button>
          )}

          {(task.status === "active" || task.status === "done") && (
            <Button
              variant="outline"
              onClick={handleReset}
              disabled={resetMutation.isPending}
            >
              {resetMutation.isPending ? (
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
              ) : (
                "Reset to Draft"
              )}
            </Button>
          )}

          <Button
            variant="destructive"
            onClick={handleDelete}
            disabled={deleteMutation.isPending}
          >
            {deleteMutation.isPending ? (
              <Loader2 className="h-4 w-4 mr-2 animate-spin" />
            ) : (
              <Trash2 className="h-4 w-4 mr-2" />
            )}
            Delete
          </Button>
        </div>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Description</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm whitespace-pre-wrap">{task.data.description}</p>
          {task.data.context && (
            <div className="mt-4 pt-4 border-t">
              <h4 className="text-sm font-medium text-muted-foreground mb-2">
                Additional Context
              </h4>
              <p className="text-sm whitespace-pre-wrap text-muted-foreground">
                {task.data.context}
              </p>
            </div>
          )}
        </CardContent>
      </Card>

      {task.data.branchName && (
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
                {task.data.branchName}
              </code>
            </div>
          </CardContent>
        </Card>
      )}

      {totalCount > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>
              Sessions Progress
              {allSessions.length > totalCount && (
                <span className="text-sm font-normal text-muted-foreground ml-2">
                  ({allSessions.length} with subsessions)
                </span>
              )}
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex items-center gap-3">
              <Progress value={progressPercent} className="flex-1" />
              <span className="text-sm font-medium min-w-[60px] text-right">
                {completedCount}/{totalCount}
              </span>
            </div>

            {hasRunningSessions && (
              <Badge variant="secondary">
                {runningCount} session{runningCount > 1 ? "s" : ""} running
              </Badge>
            )}

            <ExpandableInterventions
              permissions={allPermissions}
              questions={allQuestions}
              compact={false}
            />

            <TaskSessionHierarchy
              hierarchy={hierarchy}
              taskSessions={sessions}
              interactions={interactionState.sessions}
              opencodeUrl={sandbox?.runtime?.urls?.opencode}
              directory={sandbox?.workspaceId ?? "/home/dev/workspace"}
            />
          </CardContent>
        </Card>
      )}

      {task.status === "active" && secondaryTemplates.length > 0 && (
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
                  taskId={task.id}
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
              {task.id}
            </code>

            <div className="text-muted-foreground">Status</div>
            <Badge variant="outline" className="w-fit">
              {task.status}
            </Badge>

            {task.data.sandboxId && (
              <>
                <div className="text-muted-foreground">Sandbox ID</div>
                {sandbox ? (
                  <Link
                    to="/sandboxes/$id"
                    params={{ id: task.data.sandboxId }}
                    className="font-mono bg-muted px-2 py-1 rounded truncate text-blue-500 hover:underline"
                  >
                    {task.data.sandboxId}
                  </Link>
                ) : (
                  <code className="font-mono bg-muted px-2 py-1 rounded truncate">
                    {task.data.sandboxId}
                  </code>
                )}
              </>
            )}

            {sessions.length > 0 && (
              <>
                <div className="text-muted-foreground">Sessions</div>
                <span>{sessions.length} total</span>
              </>
            )}

            {task.data.startedAt && (
              <>
                <div className="text-muted-foreground">Started</div>
                <span>{new Date(task.data.startedAt).toLocaleString()}</span>
              </>
            )}

            {task.data.completedAt && (
              <>
                <div className="text-muted-foreground">Completed</div>
                <span>{new Date(task.data.completedAt).toLocaleString()}</span>
              </>
            )}

            <div className="text-muted-foreground">Created</div>
            <span>{new Date(task.createdAt).toLocaleString()}</span>

            <div className="text-muted-foreground">Updated</div>
            <span>{new Date(task.updatedAt).toLocaleString()}</span>
          </div>
        </CardContent>
      </Card>
    </div>
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
