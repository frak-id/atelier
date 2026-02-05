import type { Task } from "@frak/atelier-manager/types";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import {
  AlertTriangle,
  Bot,
  ExternalLink,
  Globe,
  Loader2,
  Maximize2,
  Monitor,
  Pause,
  Play,
  RotateCcw,
  Terminal,
  Trash2,
} from "lucide-react";
import { useEffect, useRef } from "react";
import type { Sandbox, Workspace } from "@/api/client";
import {
  deriveBrowserStatus,
  opencodeSessionsQuery,
  sandboxDevCommandsQuery,
  sandboxGitStatusQuery,
  sandboxServicesQuery,
  useStartBrowser,
} from "@/api/queries";
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
import { useOpencodeData } from "@/hooks/use-opencode-data";
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
            <BrowserStatusBadge sandboxId={sandbox.id} sandbox={sandbox} />
          )}

          {sandbox.status === "running" && (
            <SandboxActivitySummary
              opencodeUrl={sandbox.runtime.urls.opencode}
            />
          )}

          {sandbox.status === "running" && (
            <SandboxGitBadges sandboxId={sandbox.id} />
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
                    <Link to="/sandboxes/$id" params={{ id: sandbox.id }}>
                      <Maximize2 className="h-4 w-4" />
                    </Link>
                  </Button>
                </TooltipTrigger>
                <TooltipContent>Immerse</TooltipContent>
              </Tooltip>

              <CardBrowserButton sandboxId={sandbox.id} sandbox={sandbox} />

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
                    <Link
                      to="/sandboxes/$id"
                      params={{ id: sandbox.id }}
                      search={{ tab1: "terminal" }}
                    >
                      <Terminal className="h-4 w-4" />
                    </Link>
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

function BrowserStatusBadge({
  sandboxId,
  sandbox,
}: {
  sandboxId: string;
  sandbox: Sandbox;
}) {
  const { data: services } = useQuery({
    ...sandboxServicesQuery(sandboxId),
    refetchInterval: 2000,
  });
  const browserStatus = deriveBrowserStatus(services, sandbox);

  if (browserStatus.status === "off") return null;

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: Stop propagation wrapper
    // biome-ignore lint/a11y/useKeyWithClickEvents: Stop propagation wrapper
    <div className="flex flex-wrap gap-2" onClick={(e) => e.stopPropagation()}>
      <Badge
        variant="outline"
        className="h-6 gap-1.5 font-normal bg-background/50"
      >
        {browserStatus.status === "starting" ? (
          <Loader2 className="h-3 w-3 animate-spin" />
        ) : (
          <span className="w-1.5 h-1.5 rounded-full bg-green-500 animate-pulse" />
        )}
        {browserStatus.status === "running" && browserStatus.url ? (
          <a
            href={`${browserStatus.url}/?autoconnect=true&resize=remote`}
            target="_blank"
            rel="noopener noreferrer"
            className="hover:underline flex items-center gap-1"
          >
            Browser
            <ExternalLink className="h-3 w-3 opacity-50" />
          </a>
        ) : (
          <span>
            Browser {browserStatus.status === "starting" ? "starting..." : ""}
          </span>
        )}
      </Badge>
    </div>
  );
}

function CardBrowserButton({
  sandboxId,
  sandbox,
}: {
  sandboxId: string;
  sandbox: Sandbox;
}) {
  const startBrowser = useStartBrowser(sandboxId);
  const { data: services } = useQuery({
    ...sandboxServicesQuery(sandboxId),
    refetchInterval: 2000,
  });
  const browserStatus = deriveBrowserStatus(services, sandbox);
  const pendingOpenRef = useRef(false);

  useEffect(() => {
    if (
      pendingOpenRef.current &&
      browserStatus?.status === "running" &&
      browserStatus.url
    ) {
      pendingOpenRef.current = false;
      window.open(
        `${browserStatus.url}/?autoconnect=true&resize=remote`,
        "_blank",
      );
    }
  }, [browserStatus?.status, browserStatus?.url]);

  const handleClick = () => {
    if (browserStatus?.status === "running" && browserStatus.url) {
      window.open(
        `${browserStatus.url}/?autoconnect=true&resize=remote`,
        "_blank",
      );
      return;
    }
    pendingOpenRef.current = true;
    startBrowser.mutate();
  };

  const isLoading =
    startBrowser.isPending || browserStatus?.status === "starting";

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="h-8 w-8 text-muted-foreground hover:text-foreground"
          onClick={handleClick}
          disabled={isLoading}
        >
          {isLoading ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <Globe className="h-4 w-4" />
          )}
        </Button>
      </TooltipTrigger>
      <TooltipContent>
        {browserStatus?.status === "running" ? "Open Browser" : "Start Browser"}
      </TooltipContent>
    </Tooltip>
  );
}

function SandboxActivitySummary({
  opencodeUrl,
}: {
  opencodeUrl: string | undefined;
}) {
  const { sessionStatuses, permissions, questions } =
    useOpencodeData(opencodeUrl);
  const { data: sessions } = useQuery({
    ...opencodeSessionsQuery(opencodeUrl ?? ""),
    enabled: !!opencodeUrl,
  });

  const sessionCount = sessions?.length ?? 0;
  const workingCount = Object.values(sessionStatuses).filter(
    (s) => s.type === "busy",
  ).length;
  const attentionCount = permissions.length + questions.length;

  if (sessionCount === 0) return null;

  return (
    <div className="flex flex-wrap gap-1.5">
      <Badge
        variant="outline"
        className="text-[10px] h-5 px-1.5 gap-1 font-normal"
      >
        <Bot className="h-3 w-3" />
        {sessionCount} session{sessionCount !== 1 ? "s" : ""}
      </Badge>
      {workingCount > 0 && (
        <Badge
          variant="secondary"
          className="text-[10px] h-5 px-1.5 gap-1 font-normal"
        >
          <span className="w-1.5 h-1.5 rounded-full bg-blue-500 animate-pulse" />
          {workingCount} working
        </Badge>
      )}
      {attentionCount > 0 && (
        <Badge
          variant="outline"
          className="text-[10px] h-5 px-1.5 gap-1 font-normal border-amber-500/50 text-amber-600 dark:text-amber-400"
        >
          <AlertTriangle className="h-3 w-3" />
          {attentionCount} need attention
        </Badge>
      )}
    </div>
  );
}

function SandboxGitBadges({ sandboxId }: { sandboxId: string }) {
  const { data: gitStatus } = useQuery(sandboxGitStatusQuery(sandboxId));

  if (!gitStatus?.repos?.length) return null;

  const isDirty = gitStatus.repos.some((r) => r.dirty);
  const totalAhead = gitStatus.repos.reduce(
    (sum, r) => sum + (r.ahead ?? 0),
    0,
  );

  if (!isDirty && totalAhead === 0) return null;

  return (
    <div className="flex flex-wrap gap-1.5">
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
  );
}

function SandboxDevStatus({ sandboxId }: { sandboxId: string }) {
  const { data } = useQuery(sandboxDevCommandsQuery(sandboxId));

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
