import type { Task } from "@frak-sandbox/manager/types";
import { useQuery } from "@tanstack/react-query";
import {
  CheckCircle,
  Clock,
  Code,
  ExternalLink,
  GitBranch,
  Loader2,
  Terminal,
} from "lucide-react";
import { sandboxDetailQuery } from "@/api/queries";
import { ExpandableInterventions } from "@/components/expandable-interventions";
import { SessionStatusIndicator } from "@/components/session-status-indicator";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  type SessionInteractionState,
  useTaskSessionProgress,
} from "@/hooks/use-task-session-progress";
import { buildOpenCodeSessionUrl } from "@/lib/utils";

type TaskDetailDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  task: Task | null;
};

export function TaskDetailDialog({
  open,
  onOpenChange,
  task,
}: TaskDetailDialogProps) {
  if (!task) return null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="text-xl">{task.title}</DialogTitle>
        </DialogHeader>

        <TaskDetailContent task={task} />
      </DialogContent>
    </Dialog>
  );
}

function TaskDetailContent({ task }: { task: Task }) {
  const { data: sandbox } = useQuery({
    ...sandboxDetailQuery(task.data.sandboxId ?? ""),
    enabled: !!task.data.sandboxId,
  });

  const {
    allSessions,
    totalCount,
    sessionInteractions,
    aggregatedInteraction,
    needsAttention,
    hasBusySessions,
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

  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-sm font-medium text-muted-foreground mb-2">
          Description
        </h3>
        <p className="text-sm whitespace-pre-wrap">{task.data.description}</p>
      </div>

      {task.data.context && (
        <div>
          <h3 className="text-sm font-medium text-muted-foreground mb-2">
            Additional Context
          </h3>
          <p className="text-sm whitespace-pre-wrap text-muted-foreground">
            {task.data.context}
          </p>
        </div>
      )}

      {task.data.branchName && (
        <div className="flex items-center gap-2">
          <GitBranch className="h-4 w-4 text-muted-foreground" />
          <code className="text-sm bg-muted px-2 py-1 rounded">
            {task.data.branchName}
          </code>
        </div>
      )}

      {totalCount > 0 && (
        <div>
          <h3 className="text-sm font-medium text-muted-foreground mb-2">
            Sessions
          </h3>
          <div className="space-y-3">
            {hasBusySessions && <Badge variant="secondary">Working</Badge>}

            {needsAttention && (
              <ExpandableInterventions
                permissions={aggregatedInteraction.pendingPermissions}
                questions={aggregatedInteraction.pendingQuestions}
                compact={true}
              />
            )}

            <div className="space-y-1 max-h-[200px] overflow-y-auto">
              {allSessions.map((session) => {
                const sessionInteraction = sessionInteractions.find(
                  (s) => s.sessionId === session.id,
                );
                const taskSession = task.data.sessions?.find(
                  (ts) => ts.id === session.id,
                );
                return (
                  <TaskSessionRow
                    key={session.id}
                    sessionId={session.id}
                    templateId={taskSession?.templateId}
                    interaction={sessionInteraction}
                    opencodeUrl={sandbox?.runtime?.urls?.opencode}
                    directory={session.directory}
                  />
                );
              })}
            </div>
          </div>
        </div>
      )}

      {sandbox?.status === "running" && sandbox.runtime?.urls && (
        <div>
          <h3 className="text-sm font-medium text-muted-foreground mb-2">
            Quick Access
          </h3>
          <div className="flex items-center gap-2">
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
          </div>
        </div>
      )}

      <div className="border-t pt-4">
        <h3 className="text-sm font-medium text-muted-foreground mb-3">
          Debug Info
        </h3>
        <div className="grid grid-cols-2 gap-2 text-xs">
          <div className="text-muted-foreground">Task ID</div>
          <code className="font-mono bg-muted px-1.5 py-0.5 rounded truncate">
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
                <a
                  href={`/sandboxes/${task.data.sandboxId}`}
                  className="font-mono bg-muted px-1.5 py-0.5 rounded truncate text-blue-500 hover:underline"
                >
                  {task.data.sandboxId}
                </a>
              ) : (
                <code className="font-mono bg-muted px-1.5 py-0.5 rounded truncate">
                  {task.data.sandboxId}
                </code>
              )}
            </>
          )}

          {allSessions.length > 0 && (
            <>
              <div className="text-muted-foreground">Sessions</div>
              <span>{allSessions.length} total</span>
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
      </div>
    </div>
  );
}

function TaskSessionRow({
  sessionId,
  templateId,
  interaction,
  opencodeUrl,
  directory,
}: {
  sessionId: string;
  templateId: string | undefined;
  interaction: SessionInteractionState | undefined;
  opencodeUrl: string | undefined;
  directory: string;
}) {
  const shortId = sessionId.slice(0, 8);
  const status = interaction?.status ?? "unknown";

  const needsAttention =
    interaction &&
    (interaction.pendingPermissions.length > 0 ||
      interaction.pendingQuestions.length > 0);

  const sessionUrl =
    opencodeUrl && directory
      ? buildOpenCodeSessionUrl(opencodeUrl, directory, sessionId)
      : undefined;

  return (
    <div className="flex items-center gap-2 text-xs py-1.5 px-2 bg-muted/50 rounded">
      {status === "idle" ? (
        <Clock className="h-3.5 w-3.5 text-amber-500 shrink-0" />
      ) : status === "busy" ? (
        <Loader2 className="h-3.5 w-3.5 text-blue-500 shrink-0 animate-spin" />
      ) : (
        <CheckCircle className="h-3.5 w-3.5 text-green-500 shrink-0" />
      )}
      <span className="truncate flex-1">
        {templateId ?? "Session"}{" "}
        <span className="font-mono text-muted-foreground">({shortId})</span>
      </span>

      {interaction && (
        <SessionStatusIndicator
          interaction={{
            status: interaction.status,
            pendingPermissions: interaction.pendingPermissions,
            pendingQuestions: interaction.pendingQuestions,
          }}
          compact
        />
      )}

      {needsAttention && sessionUrl && (
        <Button
          variant="outline"
          size="sm"
          className="h-5 text-[10px] px-1.5 gap-0.5"
          asChild
        >
          <a href={sessionUrl} target="_blank" rel="noopener noreferrer">
            <ExternalLink className="h-2.5 w-2.5" />
            Respond
          </a>
        </Button>
      )}

      {!needsAttention && sessionUrl && (
        <Button variant="ghost" size="sm" className="h-5 w-5 p-0" asChild>
          <a href={sessionUrl} target="_blank" rel="noopener noreferrer">
            <ExternalLink className="h-3 w-3" />
          </a>
        </Button>
      )}
    </div>
  );
}
