import type { Task } from "@frak/atelier-manager/types";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import {
  AlertTriangle,
  Bot,
  ExternalLink,
  HeartPulse,
  Loader2,
  Maximize2,
  Pause,
  Play,
  RotateCcw,
  Trash2,
} from "lucide-react";
import type { Sandbox, Workspace } from "@/api/client";
import {
  deriveToolStatus,
  opencodeSessionsQuery,
  organizationListQuery,
  sandboxGitStatusQuery,
  sandboxToolsQuery,
  useOrganizationMap,
  useSandboxServices,
} from "@/api/queries";
import { IntegrationSourceBadge } from "@/components/integration-source-badge";
import { SandboxCreator } from "@/components/sandbox-creator";
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
import { sortToolsForDisplay } from "@/lib/tools";
import { formatRelativeTime } from "@/lib/utils";
import { ToolIconButton } from "./sandbox-drawer/tool-button";

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
  onRecover?: () => void;
  isRecovering?: boolean;
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
  onRecover,
  isRecovering,
  onShowDetails,
  onShowTask,
}: SandboxCardProps) {
  const { data: services } = useSandboxServices(
    sandbox.id,
    sandbox.status === "running",
  );
  const { data: tools } = useQuery({
    ...sandboxToolsQuery(sandbox.id),
    enabled: sandbox.status === "running",
  });
  const orgMap = useOrganizationMap();
  const { data: organizations } = useQuery(organizationListQuery());
  const orgName =
    organizations && organizations.length > 1 && sandbox.orgId
      ? orgMap.get(sandbox.orgId)
      : undefined;

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
        className="flex-1 flex flex-col cursor-pointer hover:bg-muted/50 transition-colors focus:outline-hidden focus:bg-muted/50"
        onClick={onShowDetails}
        onKeyDown={handleKeyDown}
      >
        <CardHeader className="pb-3 space-y-2">
          <div className="flex items-start justify-between gap-2">
            <div className="flex flex-col gap-1 min-w-0">
              <div className="flex items-center gap-2 min-w-0">
                <CardTitle
                  className="text-base truncate"
                  title={
                    sandbox.name
                      ? `${sandbox.name} (${sandbox.id})`
                      : sandbox.id
                  }
                >
                  {sandbox.name ? (
                    <span>{sandbox.name}</span>
                  ) : (
                    <span className="font-mono">{sandbox.id}</span>
                  )}
                </CardTitle>
                <IntegrationSourceBadge integration={sandbox.origin} />
                <Badge
                  variant={statusVariant[sandbox.status]}
                  className="capitalize"
                >
                  {sandbox.status}
                </Badge>
                {orgName && (
                  <Badge variant="outline" className="text-xs">
                    {orgName}
                  </Badge>
                )}
              </div>
              {sandbox.name && (
                <span
                  className="text-[10px] font-mono text-muted-foreground/70 truncate"
                  title={sandbox.id}
                >
                  {sandbox.id}
                </span>
              )}
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
            <div className="flex flex-col items-end gap-1 shrink-0">
              <span className="text-xs text-muted-foreground whitespace-nowrap">
                {formatRelativeTime(sandbox.createdAt)}
              </span>
              <SandboxCreator
                userId={sandbox.createdBy}
                className="max-w-[120px]"
              />
            </div>
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
            <RunningToolsBadge
              sandboxId={sandbox.id}
              tools={tools ?? []}
              services={services}
            />
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

              {sortToolsForDisplay(tools ?? []).map((tool) => (
                <ToolIconButton
                  key={tool.slug}
                  sandboxId={sandbox.id}
                  tool={tool}
                  status={deriveToolStatus(services, tool)}
                />
              ))}
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

        {sandbox.status === "error" && onRecover && (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="sm"
                onClick={onRecover}
                disabled={isRecovering}
                className="h-8 px-2"
              >
                {isRecovering ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <HeartPulse className="h-4 w-4 mr-1.5" />
                )}
                Recover
              </Button>
            </TooltipTrigger>
            <TooltipContent>Recover Sandbox</TooltipContent>
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

function RunningToolsBadge({
  sandboxId,
  tools,
  services,
}: {
  sandboxId: string;
  tools: Array<{
    slug: string;
    name: string;
    start: "boot" | "lazy";
    exposed: boolean;
    services: string[];
  }>;
  services: { services: Array<{ name: string; running: boolean }> } | undefined;
}) {
  const running = sortToolsForDisplay(tools).filter(
    (tool) =>
      tool.start === "lazy" &&
      tool.exposed &&
      deriveToolStatus(services, tool) === "running",
  );

  if (running.length === 0) return null;

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: Stop propagation wrapper
    // biome-ignore lint/a11y/useKeyWithClickEvents: Stop propagation wrapper
    <div className="flex flex-wrap gap-2" onClick={(e) => e.stopPropagation()}>
      {running.map((tool) => (
        <Badge
          key={tool.slug}
          variant="outline"
          className="h-6 gap-1.5 font-normal bg-background/50"
        >
          <span className="w-1.5 h-1.5 rounded-full bg-green-500 animate-pulse" />
          <Link
            to="/sandboxes/$id"
            params={{ id: sandboxId }}
            search={{ tab1: tool.slug }}
            target="_blank"
            className="hover:underline flex items-center gap-1"
          >
            {tool.name}
            <ExternalLink className="h-3 w-3 opacity-50" />
          </Link>
        </Badge>
      ))}
    </div>
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
  const { data: tools } = useQuery(sandboxToolsQuery(sandboxId));
  const { data: servicesData } = useSandboxServices(sandboxId);
  const devTool = tools?.find((t) => t.slug === "dev");

  if (!devTool || deriveToolStatus(servicesData, devTool) !== "running") {
    return null;
  }

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: Stop propagation wrapper
    // biome-ignore lint/a11y/useKeyWithClickEvents: Stop propagation wrapper
    <div className="flex flex-wrap gap-2" onClick={(e) => e.stopPropagation()}>
      <Badge
        variant="outline"
        className="h-6 gap-1.5 font-normal bg-background/50"
      >
        <span className="w-1.5 h-1.5 rounded-full bg-green-500 animate-pulse" />
        {devTool.url ? (
          <a
            href={devTool.url}
            target="_blank"
            rel="noopener noreferrer"
            className="hover:underline flex items-center gap-1"
          >
            Dev Server
            <ExternalLink className="h-3 w-3 opacity-50" />
          </a>
        ) : (
          <span>Dev Server</span>
        )}
      </Badge>
    </div>
  );
}
