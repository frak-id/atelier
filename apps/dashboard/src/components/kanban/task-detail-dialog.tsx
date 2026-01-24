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
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Progress } from "@/components/ui/progress";

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

  const sessions = task.data.sessions ?? [];
  const completedSessions = sessions.filter((s) => s.status === "completed");
  const runningSessions = sessions.filter((s) => s.status === "running");
  const totalCount = sessions.length;
  const progressPercent =
    totalCount > 0
      ? Math.round((completedSessions.length / totalCount) * 100)
      : 0;

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
            Sessions Progress
          </h3>
          <div className="space-y-3">
            <div className="flex items-center gap-3">
              <Progress value={progressPercent} className="flex-1" />
              <span className="text-sm font-medium min-w-[60px] text-right">
                {completedSessions.length}/{totalCount}
              </span>
            </div>
            <div className="space-y-1 max-h-[200px] overflow-y-auto">
              {sessions.map((session) => (
                <SessionRow key={session.id} session={session} />
              ))}
            </div>
          </div>
        </div>
      )}

      {runningSessions.length > 0 && (
        <Badge variant="secondary">
          {runningSessions.length} session
          {runningSessions.length > 1 ? "s" : ""} running
        </Badge>
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
      </div>
    </div>
  );
}

interface TaskSession {
  id: string;
  templateId: string;
  order: number;
  status: "pending" | "running" | "completed";
  startedAt?: string;
  completedAt?: string;
}

function SessionRow({ session }: { session: TaskSession }) {
  const shortId = session.id.slice(0, 8);

  return (
    <div className="flex items-center gap-2 text-xs py-1 px-2 bg-muted/50 rounded">
      {session.status === "completed" ? (
        <CheckCircle className="h-3.5 w-3.5 text-green-500 shrink-0" />
      ) : session.status === "pending" ? (
        <Clock className="h-3.5 w-3.5 text-yellow-500 shrink-0" />
      ) : (
        <Loader2 className="h-3.5 w-3.5 text-blue-500 shrink-0 animate-spin" />
      )}
      <span className="truncate flex-1">
        {session.templateId}{" "}
        <span className="font-mono text-muted-foreground">({shortId})</span>
      </span>
      <span className="text-muted-foreground shrink-0">
        {session.startedAt
          ? new Date(session.startedAt).toLocaleTimeString()
          : ""}
      </span>
    </div>
  );
}
