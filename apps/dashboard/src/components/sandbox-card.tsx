import type { Task } from "@frak-sandbox/manager/types";
import { useQuery } from "@tanstack/react-query";
import {
  Bot,
  ExternalLink,
  Loader2,
  Monitor,
  Pause,
  Play,
  RotateCcw,
  Terminal,
  Trash2,
} from "lucide-react";
import type { Sandbox, Workspace } from "@/api/client";
import { sandboxDevCommandsQuery } from "@/api/queries";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { formatRelativeTime } from "@/lib/utils";

interface SandboxCardProps {
  sandbox: Sandbox;
  workspace?: Workspace;
  task?: Task;
  onDelete: () => void;
  onRecreate?: () => void;
  isRecreating?: boolean;
  onStop?: () => void;
  onStart?: () => void;
  isStopping?: boolean;
  isStarting?: boolean;
  onShowDetails: () => void;
  onShowTask?: () => void;
}

export function SandboxCard({
  sandbox,
  workspace,
  task,
  onDelete,
  onRecreate,
  isRecreating,
  onStop,
  onStart,
  isStopping,
  isStarting,
  onShowDetails,
  onShowTask,
}: SandboxCardProps) {
  const statusVariant = {
    running: "success",
    creating: "warning",
    stopped: "secondary",
    error: "error",
  } as const;

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" || e.key === " ") {
      onShowDetails();
      e.preventDefault();
    }
  };

  return (
    <Card className="flex flex-col h-full overflow-hidden transition-all hover:shadow-md">
      {/* biome-ignore lint/a11y/useSemanticElements: Button cannot nest interactive elements */}
      <div
        role="button"
        tabIndex={0}
        className="flex-1 flex flex-col cursor-pointer hover:bg-muted/50 transition-colors focus:outline-none focus:bg-muted/50"
        onClick={onShowDetails}
        onKeyDown={handleKeyDown}
      >
        <CardHeader className="pb-3 space-y-2">
          <div className="flex items-start justify-between gap-2">
            <div className="flex flex-col gap-1 min-w-0">
              <div className="flex items-center gap-2">
                <CardTitle
                  className="text-base font-mono truncate"
                  title={sandbox.id}
                >
                  {sandbox.id}
                </CardTitle>
                <Badge
                  variant={statusVariant[sandbox.status]}
                  className="capitalize"
                >
                  {sandbox.status}
                </Badge>
              </div>
              {(sandbox.workspaceId || task) && (
                <p className="text-sm text-muted-foreground truncate flex items-center gap-1.5">
                  {sandbox.workspaceId && (
                    <span title={workspace?.name ?? sandbox.workspaceId}>
                      {workspace?.name ?? sandbox.workspaceId}
                    </span>
                  )}
                  {sandbox.workspaceId && task && (
                    <span className="text-muted-foreground/50">•</span>
                  )}
                  {task && (
                    // biome-ignore lint/a11y/noStaticElementInteractions: Stop propagation wrapper
                    // biome-ignore lint/a11y/useKeyWithClickEvents: Stop propagation wrapper
                    <span
                      className="truncate hover:text-foreground transition-colors cursor-pointer"
                      title={task.title}
                      onClick={(e) => {
                        e.stopPropagation();
                        onShowTask?.();
                      }}
                    >
                      {task.title}
                    </span>
                  )}
                </p>
              )}
            </div>
            <span className="text-xs text-muted-foreground whitespace-nowrap shrink-0">
              {formatRelativeTime(sandbox.createdAt)}
            </span>
          </div>
        </CardHeader>
        <CardContent className="py-3 space-y-4">
          <div className="text-sm text-muted-foreground flex gap-4">
            <div className="flex items-center gap-1.5">
              <div className="h-1.5 w-1.5 rounded-full bg-current opacity-50" />
              <span>{sandbox.runtime.vcpus} vCPU</span>
            </div>
            <div className="flex items-center gap-1.5">
              <div className="h-1.5 w-1.5 rounded-full bg-current opacity-50" />
              <span>{sandbox.runtime.memoryMb} MB</span>
            </div>
          </div>

          {sandbox.status === "running" && (
            <SandboxDevStatus sandboxId={sandbox.id} />
          )}

          {sandbox.status === "running" && (
            // biome-ignore lint/a11y/noStaticElementInteractions: Stop propagation wrapper
            // biome-ignore lint/a11y/useKeyWithClickEvents: Stop propagation wrapper
            <div
              className="flex items-center gap-1 pt-1"
              onClick={(e) => e.stopPropagation()}
            >
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8 text-muted-foreground hover:text-foreground"
                    asChild
                  >
                    <a
                      href={sandbox.runtime.urls.vscode}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      <Monitor className="h-4 w-4" />
                    </a>
                  </Button>
                </TooltipTrigger>
                <TooltipContent>VSCode</TooltipContent>
              </Tooltip>

              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8 text-muted-foreground hover:text-foreground"
                    asChild
                  >
                    <a
                      href={sandbox.runtime.urls.terminal}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      <Terminal className="h-4 w-4" />
                    </a>
                  </Button>
                </TooltipTrigger>
                <TooltipContent>Terminal</TooltipContent>
              </Tooltip>

              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8 text-muted-foreground hover:text-foreground"
                    asChild
                  >
                    <a
                      href={sandbox.runtime.urls.opencode}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      <Bot className="h-4 w-4" />
                    </a>
                  </Button>
                </TooltipTrigger>
                <TooltipContent>OpenCode</TooltipContent>
              </Tooltip>
            </div>
          )}
        </CardContent>
      </div>

      <CardFooter className="pt-3 border-t bg-muted/20 flex gap-2 justify-end">
        {sandbox.status === "running" && onStop && (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="sm"
                onClick={onStop}
                disabled={isStopping}
                className="h-8 px-2"
              >
                {isStopping ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Pause className="h-4 w-4 mr-1.5" />
                )}
                Stop
              </Button>
            </TooltipTrigger>
            <TooltipContent>Stop Sandbox</TooltipContent>
          </Tooltip>
        )}

        {sandbox.status === "stopped" && onStart && (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="sm"
                onClick={onStart}
                disabled={isStarting}
                className="h-8 px-2"
              >
                {isStarting ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Play className="h-4 w-4 mr-1.5" />
                )}
                Start
              </Button>
            </TooltipTrigger>
            <TooltipContent>Start Sandbox</TooltipContent>
          </Tooltip>
        )}

        {sandbox.status === "running" && sandbox.workspaceId && onRecreate && (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="sm"
                onClick={onRecreate}
                disabled={isRecreating}
                className="h-8 px-2"
              >
                {isRecreating ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <RotateCcw className="h-4 w-4 mr-1.5" />
                )}
                Restart
              </Button>
            </TooltipTrigger>
            <TooltipContent>Recreate Sandbox</TooltipContent>
          </Tooltip>
        )}

        {sandbox.status === "error" && sandbox.workspaceId && onRecreate && (
          <Button
            variant="ghost"
            size="sm"
            onClick={onRecreate}
            disabled={isRecreating}
            className="h-8 px-2"
          >
            {isRecreating ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <RotateCcw className="h-4 w-4 mr-1.5" />
            )}
            Retry
          </Button>
        )}

        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              onClick={onDelete}
              className="h-8 w-8 text-destructive hover:text-destructive hover:bg-destructive/10 ml-auto"
            >
              <Trash2 className="h-4 w-4" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Delete Sandbox</TooltipContent>
        </Tooltip>
      </CardFooter>
    </Card>
  );
}

function SandboxDevStatus({ sandboxId }: { sandboxId: string }) {
  const { data } = useQuery({
    ...sandboxDevCommandsQuery(sandboxId),
    refetchInterval: 5000,
  });

  const runningCommands = (data?.commands ?? []).filter(
    (c) => c.status === "running",
  );

  if (runningCommands.length === 0) return null;

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: Stop propagation wrapper
    // biome-ignore lint/a11y/useKeyWithClickEvents: Stop propagation wrapper
    <div className="flex flex-wrap gap-2" onClick={(e) => e.stopPropagation()}>
      {runningCommands.map((cmd) => (
        <Badge
          key={cmd.name}
          variant="outline"
          className="h-6 gap-1.5 font-normal bg-background/50"
        >
          <span className="w-1.5 h-1.5 rounded-full bg-green-500 animate-pulse" />
          {cmd.devUrl ? (
            <a
              href={cmd.devUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="hover:underline flex items-center gap-1"
            >
              {cmd.name}
              <ExternalLink className="h-3 w-3 opacity-50" />
            </a>
          ) : (
            <span>{cmd.name}</span>
          )}
        </Badge>
      ))}
    </div>
  );
}
