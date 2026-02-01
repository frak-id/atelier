import type { Session, Todo } from "@opencode-ai/sdk/v2";
import { useQueries, useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import {
  Bot,
  Check,
  ChevronDown,
  ChevronRight,
  ClipboardList,
  Copy,
  GitBranch,
  Globe,
  Key,
  Loader2,
  Maximize2,
  Monitor,
  Pause,
  Play,
  Plus,
  RefreshCw,
  RotateCcw,
  Terminal,
  Trash2,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { createOpenCodeSession } from "@/api/opencode";
import {
  opencodeSessionsQuery,
  opencodeTodosQuery,
  sandboxBrowserStatusQuery,
  sandboxDetailQuery,
  sandboxGitDiffQuery,
  sandboxGitStatusQuery,
  sandboxServicesQuery,
  taskListQuery,
  useDeleteSandbox,
  useExecCommand,
  useGitCommit,
  useGitPush,
  useRestartSandbox,
  useStartBrowser,
  useStartSandbox,
  useStopBrowser,
  useStopSandbox,
  workspaceDetailQuery,
} from "@/api/queries";
import { AttentionBlock } from "@/components/attention-block";
import { DevCommandsPanel } from "@/components/dev-commands-panel";
import { SessionHierarchy } from "@/components/session-hierarchy";
import { SSH_HOST_ALIAS } from "@/components/ssh-keys-section";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useOpencodeData } from "@/hooks/use-opencode-data";
import type { SessionInteractionState } from "@/hooks/use-task-session-progress";
import { aggregateInteractions } from "@/lib/opencode-helpers";
import {
  buildSessionHierarchy,
  flattenHierarchy,
  type SessionWithSandboxInfo,
} from "@/lib/session-hierarchy";
import { formatDate } from "@/lib/utils";

interface SandboxDrawerProps {
  sandboxId: string | null;
  onClose: () => void;
  onOpenTask?: (taskId: string) => void;
}

export function SandboxDrawer({
  sandboxId,
  onClose,
  onOpenTask,
}: SandboxDrawerProps) {
  const isOpen = !!sandboxId;
  const { data: sandbox } = useQuery({
    ...sandboxDetailQuery(sandboxId ?? ""),
    enabled: !!sandboxId,
  });

  const { data: workspace } = useQuery({
    ...workspaceDetailQuery(sandbox?.workspaceId ?? ""),
    enabled: !!sandbox?.workspaceId,
  });

  const { data: tasks } = useQuery({
    ...taskListQuery(),
    enabled: !!sandboxId,
  });
  const task = tasks?.find((t) => t.data.sandboxId === sandboxId);

  const { data: services } = useQuery({
    ...sandboxServicesQuery(sandboxId ?? ""),
    enabled: sandbox?.status === "running",
  });

  const { data: browserStatus } = useQuery({
    ...sandboxBrowserStatusQuery(sandboxId ?? ""),
    enabled: sandbox?.status === "running",
  });

  const deleteMutation = useDeleteSandbox();
  const stopMutation = useStopSandbox();
  const startMutation = useStartSandbox();
  const restartMutation = useRestartSandbox();
  const [isDeleteDialogOpen, setIsDeleteDialogOpen] = useState(false);
  const [copiedCommand, setCopiedCommand] = useState<string | null>(null);

  const copyToClipboard = (text: string, id: string) => {
    navigator.clipboard.writeText(text);
    setCopiedCommand(id);
    toast.success("Copied to clipboard");
    setTimeout(() => setCopiedCommand(null), 2000);
  };

  const statusVariant = {
    running: "success",
    creating: "warning",
    stopped: "secondary",
    error: "error",
  } as const;

  const handleDelete = () => {
    if (!sandboxId) return;
    deleteMutation.mutate(sandboxId, {
      onSuccess: () => {
        setIsDeleteDialogOpen(false);
        onClose();
        toast.success("Sandbox deleted");
      },
    });
  };

  return (
    <Sheet open={isOpen} onOpenChange={(open) => !open && onClose()}>
      <SheetContent
        side="right"
        className="w-full sm:w-[min(900px,calc(100vw-2rem))] sm:max-w-none p-0 flex flex-col gap-0"
      >
        {!sandbox ? (
          <div className="p-6">
            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
          </div>
        ) : (
          <>
            <SheetHeader className="p-4 sm:p-6 border-b flex-shrink-0">
              <div className="flex items-start justify-between gap-2">
                <div className="space-y-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <SheetTitle className="text-lg sm:text-xl font-mono truncate">
                      {sandbox.id}
                    </SheetTitle>
                    <Badge variant={statusVariant[sandbox.status]}>
                      {sandbox.status}
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
                    {task && (
                      <>
                        <button
                          type="button"
                          className="hover:text-foreground transition-colors truncate max-w-[200px] cursor-pointer"
                          title={task.title}
                          onClick={() => {
                            onClose();
                            onOpenTask?.(task.id);
                          }}
                        >
                          {task.title}
                        </button>
                        <span>•</span>
                      </>
                    )}
                    <span>Created {formatDate(sandbox.createdAt)}</span>
                  </div>
                </div>
                <Button variant="outline" size="sm" asChild>
                  <Link to="/sandboxes/$id" params={{ id: sandbox.id }}>
                    <Maximize2 className="h-4 w-4 mr-2" />
                    Immerse
                  </Link>
                </Button>
              </div>

              {sandbox.status === "running" && (
                <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-2 mt-4">
                  <div className="flex items-center gap-2 flex-wrap">
                    <Button variant="outline" size="sm" asChild>
                      <a
                        href={sandbox.runtime.urls.vscode}
                        target="_blank"
                        rel="noopener noreferrer"
                      >
                        <Monitor className="h-4 w-4 mr-2" />
                        VSCode
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
                    <Button variant="outline" size="sm" asChild>
                      <a
                        href={sandbox.runtime.urls.opencode}
                        target="_blank"
                        rel="noopener noreferrer"
                      >
                        <Bot className="h-4 w-4 mr-2" />
                        OpenCode
                      </a>
                    </Button>

                    <BrowserButton
                      sandboxId={sandbox.id}
                      browserStatus={browserStatus ?? undefined}
                    />
                  </div>
                  <div className="flex items-center gap-1">
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-8 w-8 text-muted-foreground hover:text-foreground"
                          onClick={() => stopMutation.mutate(sandbox.id)}
                          disabled={stopMutation.isPending}
                        >
                          {stopMutation.isPending ? (
                            <Loader2 className="h-4 w-4 animate-spin" />
                          ) : (
                            <Pause className="h-4 w-4" />
                          )}
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent>Stop</TooltipContent>
                    </Tooltip>
                    {sandbox.workspaceId && (
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-8 w-8 text-muted-foreground hover:text-foreground"
                            onClick={() => restartMutation.mutate(sandbox.id)}
                            disabled={restartMutation.isPending}
                          >
                            {restartMutation.isPending ? (
                              <Loader2 className="h-4 w-4 animate-spin" />
                            ) : (
                              <RotateCcw className="h-4 w-4" />
                            )}
                          </Button>
                        </TooltipTrigger>
                        <TooltipContent>Restart</TooltipContent>
                      </Tooltip>
                    )}
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-8 w-8 text-destructive hover:text-destructive hover:bg-destructive/10"
                          onClick={() => setIsDeleteDialogOpen(true)}
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent>Delete</TooltipContent>
                    </Tooltip>
                  </div>
                </div>
              )}

              {sandbox.status === "stopped" && (
                <div className="flex items-center justify-end gap-1 mt-4">
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-8 w-8 text-muted-foreground hover:text-foreground"
                        onClick={() => startMutation.mutate(sandbox.id)}
                        disabled={startMutation.isPending}
                      >
                        {startMutation.isPending ? (
                          <Loader2 className="h-4 w-4 animate-spin" />
                        ) : (
                          <Play className="h-4 w-4" />
                        )}
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>Start</TooltipContent>
                  </Tooltip>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-8 w-8 text-destructive hover:text-destructive hover:bg-destructive/10"
                        onClick={() => setIsDeleteDialogOpen(true)}
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>Delete</TooltipContent>
                  </Tooltip>
                </div>
              )}

              {(sandbox.status === "error" ||
                sandbox.status === "creating") && (
                <div className="flex items-center justify-end gap-1 mt-4">
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-8 w-8 text-destructive hover:text-destructive hover:bg-destructive/10"
                        onClick={() => setIsDeleteDialogOpen(true)}
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>Delete</TooltipContent>
                  </Tooltip>
                </div>
              )}
            </SheetHeader>

            <ScrollArea className="flex-1">
              <div className="p-4 sm:p-6 space-y-4 sm:space-y-6">
                {task && (
                  <Card
                    className="cursor-pointer hover:border-primary/50 transition-colors"
                    onClick={() => {
                      onClose();
                      onOpenTask?.(task.id);
                    }}
                  >
                    <CardContent className="flex items-center gap-3 py-3">
                      <ClipboardList className="h-4 w-4 text-muted-foreground shrink-0" />
                      <div className="min-w-0 flex-1">
                        <div className="text-sm font-medium truncate">
                          {task.title}
                        </div>
                        <div className="text-xs text-muted-foreground capitalize">
                          {task.status}
                        </div>
                      </div>
                      <Badge
                        variant={
                          task.status === "active"
                            ? "default"
                            : task.status === "done"
                              ? "success"
                              : "secondary"
                        }
                      >
                        {task.status}
                      </Badge>
                    </CardContent>
                  </Card>
                )}

                {sandbox.status === "running" && (
                  <>
                    <SandboxAttentionSection
                      opencodeUrl={sandbox.runtime.urls.opencode}
                    />

                    <DevCommandsPanel sandboxId={sandbox.id} />

                    <Card>
                      <CardHeader>
                        <CardTitle className="text-base flex items-center gap-2">
                          <Key className="h-4 w-4" />
                          Quick Connect
                        </CardTitle>
                      </CardHeader>
                      <CardContent className="space-y-4">
                        <div className="space-y-2">
                          <div className="text-sm font-medium">
                            OpenCode CLI
                          </div>
                          <div className="relative">
                            <code className="block bg-muted p-3 rounded-md font-mono text-xs sm:text-sm pr-10 overflow-x-auto whitespace-nowrap">
                              opencode attach {sandbox.runtime.urls.opencode}
                            </code>
                            <Button
                              size="icon"
                              variant="ghost"
                              className="absolute right-1 top-1 h-7 w-7"
                              onClick={() =>
                                copyToClipboard(
                                  `opencode attach ${sandbox.runtime.urls.opencode}`,
                                  "opencode",
                                )
                              }
                            >
                              {copiedCommand === "opencode" ? (
                                <Check className="h-4 w-4 text-green-500" />
                              ) : (
                                <Copy className="h-4 w-4" />
                              )}
                            </Button>
                          </div>
                        </div>

                        <div className="space-y-2">
                          <div className="text-sm font-medium">
                            VSCode Remote
                          </div>
                          <div className="relative">
                            <code className="block bg-muted p-3 rounded-md font-mono text-xs sm:text-sm pr-10 overflow-x-auto whitespace-nowrap">
                              code --remote ssh-remote+{sandbox.id}@
                              {SSH_HOST_ALIAS} /workspace
                            </code>
                            <Button
                              size="icon"
                              variant="ghost"
                              className="absolute right-1 top-1 h-7 w-7"
                              onClick={() =>
                                copyToClipboard(
                                  `code --remote ssh-remote+${sandbox.id}@${SSH_HOST_ALIAS} /workspace`,
                                  "vscode",
                                )
                              }
                            >
                              {copiedCommand === "vscode" ? (
                                <Check className="h-4 w-4 text-green-500" />
                              ) : (
                                <Copy className="h-4 w-4" />
                              )}
                            </Button>
                          </div>
                        </div>

                        <div className="space-y-2">
                          <div className="text-sm font-medium">SSH</div>
                          <div className="relative">
                            <code className="block bg-muted p-3 rounded-md font-mono text-xs sm:text-sm pr-10 overflow-x-auto whitespace-nowrap">
                              ssh {sandbox.id}@{SSH_HOST_ALIAS}
                            </code>
                            <Button
                              size="icon"
                              variant="ghost"
                              className="absolute right-1 top-1 h-7 w-7"
                              onClick={() =>
                                copyToClipboard(
                                  `ssh ${sandbox.id}@${SSH_HOST_ALIAS}`,
                                  "ssh",
                                )
                              }
                            >
                              {copiedCommand === "ssh" ? (
                                <Check className="h-4 w-4 text-green-500" />
                              ) : (
                                <Copy className="h-4 w-4" />
                              )}
                            </Button>
                          </div>
                        </div>
                      </CardContent>
                    </Card>

                    <Tabs defaultValue="repos" className="w-full">
                      <TabsList className="w-full justify-start">
                        <TabsTrigger value="repos">Repositories</TabsTrigger>
                        <TabsTrigger value="services">Services</TabsTrigger>
                        <TabsTrigger value="sessions" className="gap-1.5">
                          Sessions
                          <SessionsTabBadge
                            opencodeUrl={sandbox.runtime.urls?.opencode}
                            sandboxId={sandbox.id}
                            workspaceId={sandbox.workspaceId}
                          />
                        </TabsTrigger>
                        <TabsTrigger value="exec">Exec</TabsTrigger>
                      </TabsList>
                      <TabsContent value="repos" className="mt-4">
                        <RepositoriesTab sandboxId={sandbox.id} />
                      </TabsContent>
                      <TabsContent value="services" className="mt-4">
                        <Card>
                          <CardHeader>
                            <CardTitle className="text-base">
                              Services
                            </CardTitle>
                          </CardHeader>
                          <CardContent>
                            {services?.services &&
                            services.services.length > 0 ? (
                              <div className="space-y-2">
                                {services.services.map((service) => (
                                  <div
                                    key={service.name}
                                    className="flex items-center justify-between py-2 border-b last:border-0"
                                  >
                                    <div className="flex items-center gap-3">
                                      <div className="font-medium">
                                        {service.name}
                                      </div>
                                    </div>
                                    <div className="flex items-center gap-2">
                                      {service.pid && (
                                        <span className="text-xs text-muted-foreground font-mono">
                                          PID: {service.pid}
                                        </span>
                                      )}
                                      <Badge
                                        variant={
                                          service.running
                                            ? "success"
                                            : "secondary"
                                        }
                                        className="h-5 px-1.5"
                                      >
                                        {service.running
                                          ? "Running"
                                          : "Stopped"}
                                      </Badge>
                                    </div>
                                  </div>
                                ))}
                              </div>
                            ) : (
                              <p className="text-sm text-muted-foreground">
                                No services detected
                              </p>
                            )}
                          </CardContent>
                        </Card>
                      </TabsContent>
                      <TabsContent value="sessions" className="mt-4">
                        <SessionsTab
                          opencodeUrl={sandbox.runtime.urls?.opencode}
                          sandboxId={sandbox.id}
                          workspaceId={sandbox.workspaceId}
                        />
                      </TabsContent>
                      <TabsContent value="exec" className="mt-4">
                        <ExecTab sandboxId={sandbox.id} />
                      </TabsContent>
                    </Tabs>
                  </>
                )}

                {sandbox.runtime.error && (
                  <Card className="border-destructive">
                    <CardHeader>
                      <CardTitle className="text-destructive text-base">
                        Error
                      </CardTitle>
                    </CardHeader>
                    <CardContent>
                      <pre className="whitespace-pre-wrap text-sm font-mono bg-destructive/10 p-4 rounded-md text-destructive-foreground">
                        {sandbox.runtime.error}
                      </pre>
                    </CardContent>
                  </Card>
                )}
              </div>
            </ScrollArea>
          </>
        )}
      </SheetContent>

      <Dialog open={isDeleteDialogOpen} onOpenChange={setIsDeleteDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete Sandbox</DialogTitle>
            <DialogDescription>
              Are you sure you want to delete this sandbox? This action cannot
              be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setIsDeleteDialogOpen(false)}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={handleDelete}
              disabled={deleteMutation.isPending}
            >
              {deleteMutation.isPending && (
                <Loader2 className="h-4 w-4 animate-spin mr-2" />
              )}
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Sheet>
  );
}

function SandboxAttentionSection({ opencodeUrl }: { opencodeUrl: string }) {
  const { permissions, questions } = useOpencodeData(opencodeUrl);

  const enrichedPermissions = useMemo(
    () => permissions.map((p) => ({ ...p, sessionId: p.sessionID })),
    [permissions],
  );
  const enrichedQuestions = useMemo(
    () => questions.map((q) => ({ ...q, sessionId: q.sessionID })),
    [questions],
  );

  if (enrichedPermissions.length === 0 && enrichedQuestions.length === 0) {
    return null;
  }

  return (
    <AttentionBlock
      permissions={enrichedPermissions}
      questions={enrichedQuestions}
      opencodeUrl={opencodeUrl}
    />
  );
}

function RepositoriesTab({ sandboxId }: { sandboxId: string }) {
  const { data, isLoading, refetch } = useQuery(
    sandboxGitStatusQuery(sandboxId),
  );

  const repos = data?.repos ?? [];

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between py-4">
        <CardTitle className="text-base flex items-center gap-2">
          <GitBranch className="h-4 w-4" />
          Repositories
        </CardTitle>
        <Button variant="ghost" size="sm" onClick={() => refetch()}>
          <RefreshCw className="h-3.5 w-3.5 mr-1" />
          Refresh
        </Button>
      </CardHeader>
      <CardContent className="pt-0">
        {isLoading ? (
          <div className="flex items-center gap-2 text-muted-foreground py-8 justify-center">
            <Loader2 className="h-4 w-4 animate-spin" />
            Loading repositories...
          </div>
        ) : repos.length === 0 ? (
          <div className="text-center py-8 text-muted-foreground">
            <GitBranch className="h-8 w-8 mx-auto mb-2 opacity-50" />
            <p className="text-sm">No repositories configured</p>
          </div>
        ) : (
          <div className="space-y-3">
            {repos.map((repo) => (
              <RepoRow key={repo.path} sandboxId={sandboxId} repo={repo} />
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function RepoRow({
  sandboxId,
  repo,
}: {
  sandboxId: string;
  repo: {
    path: string;
    branch: string | null;
    lastCommit: string | null;
    dirty: boolean;
    ahead: number;
    behind: number;
    error?: string;
  };
}) {
  const [expanded, setExpanded] = useState(false);
  const diffQuery = useQuery({
    ...sandboxGitDiffQuery(sandboxId),
    enabled: expanded,
  });

  const repoDiff = diffQuery.data?.repos?.find(
    (r: { path: string }) => r.path === repo.path,
  );

  return (
    <div className="rounded-lg border overflow-hidden">
      <button
        type="button"
        className="w-full flex items-start justify-between p-3 bg-muted/30 hover:bg-muted/50 transition-colors cursor-pointer text-left"
        onClick={() => {
          setExpanded(!expanded);
          if (!expanded && !diffQuery.data) {
            diffQuery.refetch();
          }
        }}
      >
        <div className="flex items-center gap-2 flex-1 min-w-0">
          {expanded ? (
            <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" />
          ) : (
            <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
          )}
          <div className="flex-1 min-w-0">
            <div className="font-mono text-sm font-medium truncate">
              {repo.path}
            </div>
            {repo.error ? (
              <div className="text-xs text-destructive mt-1">{repo.error}</div>
            ) : (
              <div className="flex items-center gap-3 mt-1.5">
                {repo.branch && (
                  <div className="flex items-center gap-1 text-xs">
                    <GitBranch className="h-3 w-3 text-muted-foreground" />
                    <span className="font-mono">{repo.branch}</span>
                  </div>
                )}
                {repo.lastCommit && (
                  <span
                    className="text-xs text-muted-foreground truncate max-w-[200px]"
                    title={repo.lastCommit}
                  >
                    {repo.lastCommit}
                  </span>
                )}
              </div>
            )}
          </div>
        </div>
        <div className="flex flex-col items-end gap-1.5 ml-3">
          {repo.dirty && (
            <Badge variant="warning" className="text-[10px] h-5 px-1.5">
              Dirty
            </Badge>
          )}
          {repo.ahead > 0 && (
            <Badge variant="secondary" className="text-[10px] h-5 px-1.5">
              +{repo.ahead}
            </Badge>
          )}
          {repo.behind > 0 && (
            <Badge variant="secondary" className="text-[10px] h-5 px-1.5">
              -{repo.behind}
            </Badge>
          )}
          {!repo.error && !repo.dirty && repo.ahead === 0 && (
            <Badge variant="success" className="text-[10px] h-5 px-1.5">
              Clean
            </Badge>
          )}
        </div>
      </button>

      {expanded && (
        <div className="border-t p-3 space-y-3">
          {diffQuery.isLoading ? (
            <div className="flex items-center gap-2 text-muted-foreground py-4 justify-center">
              <Loader2 className="h-4 w-4 animate-spin" />
              Loading diff...
            </div>
          ) : repoDiff && repoDiff.files.length > 0 ? (
            <div className="space-y-1">
              {repoDiff.files.map(
                (file: {
                  path: string;
                  added: number;
                  removed: number;
                  status?: string;
                }) => (
                  <div
                    key={file.path}
                    className="flex items-center justify-between px-2 py-1 rounded text-xs font-mono bg-muted/40"
                  >
                    <span className="truncate flex-1 min-w-0">{file.path}</span>
                    <div className="flex items-center gap-2 ml-2 shrink-0">
                      {file.status === "untracked" ? (
                        <Badge
                          variant="outline"
                          className="text-[9px] h-4 px-1"
                        >
                          new
                        </Badge>
                      ) : (
                        <>
                          {file.added > 0 && (
                            <span className="text-green-500">
                              +{file.added}
                            </span>
                          )}
                          {file.removed > 0 && (
                            <span className="text-red-500">
                              -{file.removed}
                            </span>
                          )}
                        </>
                      )}
                    </div>
                  </div>
                ),
              )}
              <div className="flex items-center gap-3 text-xs text-muted-foreground pt-1 px-2">
                <span className="text-green-500">+{repoDiff.totalAdded}</span>
                <span className="text-red-500">-{repoDiff.totalRemoved}</span>
                <span>
                  {repoDiff.files.length} file
                  {repoDiff.files.length !== 1 ? "s" : ""} changed
                </span>
              </div>
            </div>
          ) : (
            <div className="text-xs text-muted-foreground text-center py-2">
              Working tree clean
            </div>
          )}

          {(repo.dirty || repo.ahead > 0) && (
            <RepoCommitForm
              sandboxId={sandboxId}
              repoPath={repo.path}
              isDirty={repo.dirty}
              ahead={repo.ahead}
              onDiffRefetch={() => diffQuery.refetch()}
            />
          )}
        </div>
      )}
    </div>
  );
}

function RepoCommitForm({
  sandboxId,
  repoPath,
  isDirty,
  ahead,
  onDiffRefetch,
}: {
  sandboxId: string;
  repoPath: string;
  isDirty: boolean;
  ahead: number;
  onDiffRefetch: () => void;
}) {
  const [message, setMessage] = useState("");
  const commitMutation = useGitCommit(sandboxId);
  const pushMutation = useGitPush(sandboxId);
  const [commitAndPushing, setCommitAndPushing] = useState(false);

  const isAnyLoading =
    commitMutation.isPending || pushMutation.isPending || commitAndPushing;

  const handleCommit = () => {
    commitMutation.mutate(
      { repoPath, message },
      {
        onSuccess: (result) => {
          if (!result) return toast.error("Commit failed");
          if (result.success) {
            toast.success(`Committed: ${result.hash?.slice(0, 7) ?? "ok"}`);
            setMessage("");
            onDiffRefetch();
          } else {
            toast.error(result.error ?? "Commit failed");
          }
        },
        onError: () => toast.error("Commit failed"),
      },
    );
  };

  const handlePush = () => {
    pushMutation.mutate(repoPath, {
      onSuccess: (result) => {
        if (!result) return toast.error("Push failed");
        if (result.success) {
          toast.success("Pushed successfully");
        } else {
          toast.error(result.error ?? "Push failed");
        }
      },
      onError: () => toast.error("Push failed"),
    });
  };

  const handleCommitAndPush = async () => {
    setCommitAndPushing(true);
    try {
      const commitResult = await commitMutation.mutateAsync({
        repoPath,
        message,
      });
      if (!commitResult?.success) {
        toast.error(commitResult?.error ?? "Commit failed");
        return;
      }
      toast.success(`Committed: ${commitResult.hash?.slice(0, 7) ?? "ok"}`);

      const pushResult = await pushMutation.mutateAsync(repoPath);
      if (!pushResult?.success) {
        toast.error(pushResult?.error ?? "Push failed");
        return;
      }
      toast.success("Pushed successfully");
      setMessage("");
      onDiffRefetch();
    } catch {
      toast.error("Commit & push failed");
    } finally {
      setCommitAndPushing(false);
    }
  };

  return (
    <div className="border-t pt-3 space-y-2">
      {isDirty && (
        <input
          type="text"
          className="w-full rounded-md border bg-background px-3 py-1.5 text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
          placeholder="Commit message..."
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && message.trim()) handleCommit();
          }}
          disabled={isAnyLoading}
        />
      )}
      <div className="flex items-center gap-2">
        {isDirty && (
          <>
            <Button
              size="sm"
              variant="outline"
              disabled={!message.trim() || isAnyLoading}
              onClick={handleCommit}
            >
              {commitMutation.isPending && (
                <Loader2 className="h-3 w-3 animate-spin mr-1" />
              )}
              Commit
            </Button>
            <Button
              size="sm"
              disabled={!message.trim() || isAnyLoading}
              onClick={handleCommitAndPush}
            >
              {commitAndPushing && (
                <Loader2 className="h-3 w-3 animate-spin mr-1" />
              )}
              Commit & Push
            </Button>
          </>
        )}
        {ahead > 0 && (
          <Button
            size="sm"
            variant={isDirty ? "outline" : "default"}
            disabled={isAnyLoading}
            onClick={handlePush}
          >
            {pushMutation.isPending && (
              <Loader2 className="h-3 w-3 animate-spin mr-1" />
            )}
            Push ({ahead})
          </Button>
        )}
      </div>
    </div>
  );
}

function BrowserButton({
  sandboxId,
  browserStatus,
}: {
  sandboxId: string;
  browserStatus?: { status: string; url?: string };
}) {
  const startBrowser = useStartBrowser(sandboxId);
  const stopBrowser = useStopBrowser(sandboxId);
  const pendingOpenRef = useRef(false);

  const browserVncUrl = browserStatus?.url
    ? `${browserStatus.url}/vnc.html?autoconnect=true&resize=scale`
    : undefined;

  useEffect(() => {
    if (
      pendingOpenRef.current &&
      browserStatus?.status === "running" &&
      browserVncUrl
    ) {
      pendingOpenRef.current = false;
      window.open(browserVncUrl, "_blank");
    }
  }, [browserStatus?.status, browserVncUrl]);

  if (browserStatus?.status === "running" && browserVncUrl) {
    return (
      <div className="flex items-center gap-1">
        <Button variant="outline" size="sm" asChild>
          <a href={browserVncUrl} target="_blank" rel="noopener noreferrer">
            <Globe className="h-4 w-4 mr-2" />
            Browser
          </a>
        </Button>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => stopBrowser.mutate()}
          disabled={stopBrowser.isPending}
          className="h-8 px-2 text-muted-foreground hover:text-destructive"
        >
          {stopBrowser.isPending ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <span className="text-xs">Stop</span>
          )}
        </Button>
      </div>
    );
  }

  const handleStart = () => {
    pendingOpenRef.current = true;
    startBrowser.mutate();
  };

  return (
    <Button
      variant="outline"
      size="sm"
      onClick={handleStart}
      disabled={startBrowser.isPending || browserStatus?.status === "starting"}
    >
      {startBrowser.isPending || browserStatus?.status === "starting" ? (
        <Loader2 className="h-4 w-4 animate-spin mr-2" />
      ) : (
        <Globe className="h-4 w-4 mr-2" />
      )}
      {browserStatus?.status === "starting" ? "Starting..." : "Browser"}
    </Button>
  );
}

function SessionsTabBadge({
  opencodeUrl,
}: {
  opencodeUrl: string | undefined;
  sandboxId: string;
  workspaceId: string | undefined;
}) {
  const { data: sessions } = useQuery({
    ...opencodeSessionsQuery(opencodeUrl ?? ""),
    enabled: !!opencodeUrl,
  });

  const { permissions, questions, sessionStatuses } =
    useOpencodeData(opencodeUrl);

  const needsAttention = useMemo(() => {
    if (!sessions?.length) return false;
    const sessionIds = sessions.map((s: Session) => s.id);
    const { needsAttention } = aggregateInteractions(
      sessionIds,
      sessionStatuses,
      permissions,
      questions,
    );
    return needsAttention;
  }, [sessions, sessionStatuses, permissions, questions]);

  if (!sessions?.length) return null;

  return (
    <>
      <Badge
        variant="secondary"
        className="text-[10px] px-1.5 py-0 h-4 min-w-[1.25rem] justify-center"
      >
        {sessions.length}
      </Badge>
      {needsAttention && (
        <span className="h-2 w-2 rounded-full bg-amber-500 animate-pulse" />
      )}
    </>
  );
}

function SessionsTab({
  opencodeUrl,
  sandboxId,
  workspaceId,
}: {
  opencodeUrl: string | undefined;
  sandboxId: string;
  workspaceId: string | undefined;
}) {
  const [isCreating, setIsCreating] = useState(false);

  const { data: sessions, isLoading: isSessionsLoading } = useQuery({
    ...opencodeSessionsQuery(opencodeUrl ?? ""),
    enabled: !!opencodeUrl,
  });

  const { permissions, questions, sessionStatuses } =
    useOpencodeData(opencodeUrl);

  const directory = workspaceId ?? "/home/dev/workspace";

  const hierarchyData = useMemo(() => {
    const sessionsWithSandbox: SessionWithSandboxInfo[] = (sessions ?? []).map(
      (session: Session) => ({
        ...session,
        sandbox: {
          id: sandboxId,
          workspaceId,
          opencodeUrl: opencodeUrl ?? "",
        },
      }),
    );

    const hierarchy = buildSessionHierarchy(sessionsWithSandbox);
    const allSessions = flattenHierarchy(hierarchy);

    return {
      hierarchy,
      allSessions,
      allSessionIds: allSessions.map((s) => s.id),
    };
  }, [sessions, sandboxId, workspaceId, opencodeUrl]);

  const todosResults = useQueries({
    queries: hierarchyData.allSessionIds.map((sessionId) => ({
      ...opencodeTodosQuery(opencodeUrl ?? "", sessionId),
      enabled: !!opencodeUrl && !!sessionId,
    })),
  });

  const sessionInteractions: SessionInteractionState[] = useMemo(() => {
    const { interactions } = aggregateInteractions(
      hierarchyData.allSessionIds,
      sessionStatuses,
      permissions,
      questions,
    );

    const todosBySession = new Map<string, Todo[]>();
    for (let i = 0; i < hierarchyData.allSessionIds.length; i++) {
      const sessionId = hierarchyData.allSessionIds[i];
      if (sessionId) {
        todosBySession.set(sessionId, (todosResults[i]?.data ?? []) as Todo[]);
      }
    }

    return hierarchyData.allSessions.map((session) => {
      const interaction = interactions.get(session.id);
      return {
        sessionId: session.id,
        status: interaction?.status ?? "unknown",
        pendingPermissions: interaction?.pendingPermissions ?? [],
        pendingQuestions: interaction?.pendingQuestions ?? [],
        todos: todosBySession.get(session.id) ?? [],
      };
    });
  }, [hierarchyData, sessionStatuses, permissions, questions, todosResults]);

  const handleCreateSession = async () => {
    if (!opencodeUrl) return;
    setIsCreating(true);
    try {
      const result = await createOpenCodeSession(opencodeUrl, directory);
      if ("error" in result) {
        toast.error(result.error);
      } else {
        toast.success(`Session created: ${result.sessionId.slice(0, 8)}`);
      }
    } finally {
      setIsCreating(false);
    }
  };

  if (!opencodeUrl) {
    return (
      <Card>
        <CardContent className="py-8">
          <div className="text-center text-muted-foreground">
            <Bot className="h-8 w-8 mx-auto mb-2 opacity-50" />
            <p className="text-sm">OpenCode not available for this sandbox</p>
          </div>
        </CardContent>
      </Card>
    );
  }

  if (isSessionsLoading) {
    return (
      <div className="flex items-center gap-2 text-muted-foreground py-8 justify-center">
        <Loader2 className="h-4 w-4 animate-spin" />
        Loading sessions...
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="text-sm text-muted-foreground">
          {hierarchyData.hierarchy.length} root session
          {hierarchyData.hierarchy.length !== 1 ? "s" : ""}
          {hierarchyData.allSessions.length >
            hierarchyData.hierarchy.length && (
            <span>
              {" "}
              (
              {hierarchyData.allSessions.length -
                hierarchyData.hierarchy.length}{" "}
              sub-sessions)
            </span>
          )}
        </div>
        <Button
          size="sm"
          variant="outline"
          onClick={handleCreateSession}
          disabled={isCreating}
        >
          {isCreating ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin mr-1.5" />
          ) : (
            <Plus className="h-3.5 w-3.5 mr-1.5" />
          )}
          New Session
        </Button>
      </div>

      {hierarchyData.hierarchy.length === 0 ? (
        <Card>
          <CardContent className="py-8">
            <div className="text-center text-muted-foreground">
              <Bot className="h-8 w-8 mx-auto mb-2 opacity-50" />
              <p className="text-sm">No sessions yet</p>
              <p className="text-xs mt-1">
                Create a new session to get started
              </p>
            </div>
          </CardContent>
        </Card>
      ) : (
        <SessionHierarchy
          hierarchy={hierarchyData.hierarchy}
          interactions={sessionInteractions}
          opencodeUrl={opencodeUrl}
          directory={directory}
        />
      )}
    </div>
  );
}

function ExecTab({ sandboxId }: { sandboxId: string }) {
  const [command, setCommand] = useState("");
  const [execOutput, setExecOutput] = useState<{
    stdout: string;
    stderr: string;
    exitCode: number;
  } | null>(null);
  const execMutation = useExecCommand(sandboxId);

  const handleExec = () => {
    if (!command.trim()) return;
    execMutation.mutate(
      { command },
      {
        onSuccess: (result) => {
          setExecOutput(result);
          setCommand("");
        },
      },
    );
  };

  return (
    <Card>
      <CardHeader className="py-4">
        <CardTitle className="text-base flex items-center gap-2">
          <Terminal className="h-4 w-4" />
          Execute Command
        </CardTitle>
      </CardHeader>
      <CardContent className="pt-0 space-y-4">
        <div className="flex gap-2">
          <Input
            placeholder="Enter command..."
            value={command}
            onChange={(e) => setCommand(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleExec()}
            className="font-mono text-sm"
          />
          <Button
            onClick={handleExec}
            disabled={execMutation.isPending || !command.trim()}
            size="icon"
          >
            {execMutation.isPending ? (
              <RefreshCw className="h-4 w-4 animate-spin" />
            ) : (
              <Play className="h-4 w-4" />
            )}
          </Button>
        </div>
        {execOutput && (
          <div className="bg-black rounded-lg p-3 font-mono text-xs text-green-400 max-h-[300px] overflow-auto">
            <div className="flex items-center justify-between mb-2 text-[10px] text-muted-foreground border-b border-white/10 pb-1">
              <span>Exit code: {execOutput.exitCode}</span>
            </div>
            {execOutput.stdout && (
              <pre className="whitespace-pre-wrap">{execOutput.stdout}</pre>
            )}
            {execOutput.stderr && (
              <pre className="whitespace-pre-wrap text-red-400 mt-2">
                {execOutput.stderr}
              </pre>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
