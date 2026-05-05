import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import {
  Bot,
  ClipboardList,
  HeartPulse,
  Loader2,
  Maximize2,
  Monitor,
  Pause,
  Play,
  RotateCcw,
  Save,
  Terminal,
  Trash2,
  Zap,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { registerOpencodePassword } from "@/api/opencode";
import {
  deriveBrowserStatus,
  sandboxDetailQuery,
  taskListQuery,
  useDeleteSandbox,
  useRecoverSandbox,
  useRestartSandbox,
  useSandboxServices,
  useSandboxTokenUsage,
  useSaveAsPrebuild,
  useStartSandbox,
  useStopSandbox,
  workspaceDetailQuery,
} from "@/api/queries";
import { AttentionBlock } from "@/components/attention-block";
import { DevCommandsPanel } from "@/components/dev-commands-panel";
import { IntegrationSourceBadge } from "@/components/integration-source-badge";
import { MultiTerminal } from "@/components/multi-terminal";
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
import { formatCompact, formatDate, getWorkspaceDirectory } from "@/lib/utils";
import { BrowserButton } from "./browser-button";
import { QuickConnectCard } from "./quick-connect-card";
import { RepositoriesTab } from "./repositories-tab";
import { ServicesTab } from "./services-tab";
import { SessionsTab, SessionsTabBadge } from "./sessions-tab";

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

  useEffect(() => {
    if (sandbox?.runtime.opencodePassword) {
      registerOpencodePassword(
        sandbox.runtime.urls.opencode,
        sandbox.runtime.opencodePassword,
      );
    }
  }, [sandbox]);

  const { data: tasks } = useQuery({
    ...taskListQuery(),
    enabled: !!sandboxId,
  });
  const task = tasks?.find((t) => t.data.sandboxId === sandboxId);

  const { data: services } = useSandboxServices(
    sandboxId ?? "",
    sandbox?.status === "running",
  );

  const { data: tokenUsage } = useSandboxTokenUsage(
    sandboxId ?? "",
    sandbox?.status === "running",
  );

  const browserStatus = deriveBrowserStatus(services, sandbox);

  const workspaceDir = getWorkspaceDirectory(workspace);

  const deleteMutation = useDeleteSandbox();
  const stopMutation = useStopSandbox();
  const startMutation = useStartSandbox();
  const restartMutation = useRestartSandbox();
  const recoverMutation = useRecoverSandbox();
  const saveAsPrebuildMutation = useSaveAsPrebuild();
  const [isDeleteDialogOpen, setIsDeleteDialogOpen] = useState(false);
  const [isSaveDialogOpen, setIsSaveDialogOpen] = useState(false);

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
            <SheetHeader className="p-4 sm:p-6 border-b shrink-0">
              <div className="flex items-start justify-between gap-2">
                <div className="space-y-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <SheetTitle className="text-lg sm:text-xl truncate">
                      {sandbox.name ? (
                        <span>{sandbox.name}</span>
                      ) : (
                        <span className="font-mono">{sandbox.id}</span>
                      )}
                    </SheetTitle>
                    <IntegrationSourceBadge integration={sandbox.origin} />
                    <Badge variant={statusVariant[sandbox.status]}>
                      {sandbox.status}
                    </Badge>
                  </div>
                  {sandbox.name && (
                    <div className="font-mono text-xs text-muted-foreground/70 truncate">
                      {sandbox.id}
                    </div>
                  )}
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
                      <Link
                        to="/sandboxes/$id"
                        params={{ id: sandbox.id }}
                        search={{ tab1: "opencode" }}
                        target="_blank"
                      >
                        <Bot className="h-4 w-4 mr-2" />
                        OpenCode
                      </Link>
                    </Button>
                    <Button variant="outline" size="sm" asChild>
                      <Link
                        to="/sandboxes/$id"
                        params={{ id: sandbox.id }}
                        search={{ tab1: "vscode" }}
                        target="_blank"
                      >
                        <Monitor className="h-4 w-4 mr-2" />
                        VSCode
                      </Link>
                    </Button>
                    <Button variant="outline" size="sm" asChild>
                      <Link
                        to="/sandboxes/$id"
                        params={{ id: sandbox.id }}
                        search={{ tab1: "terminal" }}
                        target="_blank"
                      >
                        <Terminal className="h-4 w-4 mr-2" />
                        Terminal
                      </Link>
                    </Button>

                    <BrowserButton
                      sandboxId={sandbox.id}
                      browserStatus={browserStatus}
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
                      <>
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
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-8 w-8 text-muted-foreground hover:text-foreground"
                              onClick={() => setIsSaveDialogOpen(true)}
                              disabled={saveAsPrebuildMutation.isPending}
                            >
                              {saveAsPrebuildMutation.isPending ? (
                                <Loader2 className="h-4 w-4 animate-spin" />
                              ) : (
                                <Save className="h-4 w-4" />
                              )}
                            </Button>
                          </TooltipTrigger>
                          <TooltipContent>Save as Prebuild</TooltipContent>
                        </Tooltip>
                      </>
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

              {sandbox.status === "error" && (
                <div className="flex items-center justify-end gap-1 mt-4">
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-8 px-2 text-muted-foreground hover:text-foreground"
                        onClick={() =>
                          recoverMutation.mutate(sandbox.id, {
                            onSuccess: () => toast.success("Sandbox recovered"),
                            onError: () =>
                              toast.error("Failed to recover sandbox"),
                          })
                        }
                        disabled={recoverMutation.isPending}
                      >
                        {recoverMutation.isPending ? (
                          <Loader2 className="h-4 w-4 animate-spin" />
                        ) : (
                          <HeartPulse className="h-4 w-4 mr-1.5" />
                        )}
                        Recover
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>Recover Sandbox</TooltipContent>
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

              {sandbox.status === "creating" && (
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
              <div className="p-4 sm:p-6 space-y-4 sm:space-y-6 overflow-hidden">
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

                    <QuickConnectCard
                      sandboxId={sandbox.id}
                      opencodeUrl={sandbox.runtime.urls.opencode}
                      opencodePassword={sandbox.runtime.opencodePassword}
                      workspaceDir={workspaceDir}
                    />

                    {tokenUsage && (
                      <Card>
                        <CardContent className="flex flex-col gap-2 py-3">
                          <div className="flex items-center gap-2 text-sm font-medium">
                            <Zap className="h-4 w-4 text-muted-foreground" />
                            Token Usage
                          </div>
                          <div className="flex items-center gap-4 text-sm">
                            <div>
                              <span className="text-muted-foreground mr-1">
                                Tokens:
                              </span>
                              {formatCompact(tokenUsage.totalTokens)}
                            </div>
                            <div>
                              <span className="text-muted-foreground mr-1">
                                Requests:
                              </span>
                              {formatCompact(tokenUsage.totalRequests)}
                            </div>
                          </div>
                          {tokenUsage.models.length > 0 && (
                            <div className="flex flex-col mt-1">
                              {tokenUsage.models.map((m) => (
                                <div
                                  key={m.model}
                                  className="flex items-center justify-between py-1 text-xs border-b last:border-0 border-border/50"
                                >
                                  <span className="text-muted-foreground truncate mr-2">
                                    {m.model}
                                  </span>
                                  <span className="font-mono">
                                    {formatCompact(m.tokens)}
                                  </span>
                                </div>
                              ))}
                            </div>
                          )}
                        </CardContent>
                      </Card>
                    )}

                    <Tabs
                      key={sandbox.id}
                      defaultValue="repos"
                      className="w-full"
                    >
                      <TabsList className="w-full justify-start overflow-x-auto">
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
                        <TabsTrigger value="terminal">Terminal</TabsTrigger>
                      </TabsList>
                      <TabsContent value="repos" className="mt-4">
                        <RepositoriesTab sandboxId={sandbox.id} />
                      </TabsContent>
                      <TabsContent value="services" className="mt-4">
                        <ServicesTab
                          sandboxId={sandbox.id}
                          services={services?.services}
                        />
                      </TabsContent>
                      <TabsContent value="sessions" className="mt-4">
                        <SessionsTab
                          opencodeUrl={sandbox.runtime.urls?.opencode}
                          sandboxId={sandbox.id}
                          workspaceId={sandbox.workspaceId}
                          workspace={workspace}
                        />
                      </TabsContent>
                      <TabsContent value="terminal" className="mt-4">
                        <TerminalTab sandboxId={sandbox.id} />
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

      <Dialog open={isSaveDialogOpen} onOpenChange={setIsSaveDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Save as Prebuild</DialogTitle>
            <DialogDescription>
              This will snapshot the current sandbox state as a prebuild for its
              workspace. The sandbox will be briefly stopped and restarted
              during the process.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setIsSaveDialogOpen(false)}
            >
              Cancel
            </Button>
            <Button
              onClick={() => {
                if (!sandboxId) return;
                saveAsPrebuildMutation.mutate(sandboxId, {
                  onSuccess: () => {
                    setIsSaveDialogOpen(false);
                    toast.success("Sandbox saved as prebuild");
                  },
                  onError: () => {
                    toast.error("Failed to save as prebuild");
                  },
                });
              }}
              disabled={saveAsPrebuildMutation.isPending}
            >
              {saveAsPrebuildMutation.isPending && (
                <Loader2 className="h-4 w-4 animate-spin mr-2" />
              )}
              Save
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

function TerminalTab({ sandboxId }: { sandboxId: string }) {
  return (
    <Card className="overflow-hidden">
      <CardHeader className="py-3 flex flex-row items-center justify-between">
        <CardTitle className="text-base flex items-center gap-2">
          <Terminal className="h-4 w-4" />
          Terminal
        </CardTitle>
        <Button variant="ghost" size="sm" asChild className="h-7 px-2">
          <Link
            to="/sandboxes/$id"
            params={{ id: sandboxId }}
            search={{ tab1: "terminal" }}
          >
            <Maximize2 className="h-3.5 w-3.5 mr-1.5" />
            Expand
          </Link>
        </Button>
      </CardHeader>
      <CardContent className="p-0">
        <MultiTerminal sandboxId={sandboxId} className="h-[350px]" />
      </CardContent>
    </Card>
  );
}
