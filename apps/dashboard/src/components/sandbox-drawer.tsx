import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import {
  Bot,
  Check,
  Copy,
  GitBranch,
  Key,
  Loader2,
  Monitor,
  Play,
  RefreshCw,
  Terminal,
  Trash2,
} from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import {
  sandboxDetailQuery,
  sandboxGitStatusQuery,
  sandboxServicesQuery,
  useDeleteSandbox,
  useExecCommand,
  workspaceDetailQuery,
} from "@/api/queries";
import { DevCommandsPanel } from "@/components/dev-commands-panel";
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
import { formatDate } from "@/lib/utils";

interface SandboxDrawerProps {
  sandboxId: string | null;
  onClose: () => void;
}

export function SandboxDrawer({ sandboxId, onClose }: SandboxDrawerProps) {
  const isOpen = !!sandboxId;
  const { data: sandbox } = useQuery({
    ...sandboxDetailQuery(sandboxId ?? ""),
    enabled: !!sandboxId,
  });

  const { data: workspace } = useQuery({
    ...workspaceDetailQuery(sandbox?.workspaceId ?? ""),
    enabled: !!sandbox?.workspaceId,
  });

  const { data: services } = useQuery({
    ...sandboxServicesQuery(sandboxId ?? ""),
    enabled: sandbox?.status === "running",
  });

  const deleteMutation = useDeleteSandbox();
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
        className="w-[700px] sm:w-[700px] sm:max-w-none p-0 flex flex-col gap-0"
      >
        {!sandbox ? (
          <div className="p-6">
            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
          </div>
        ) : (
          <>
            <SheetHeader className="p-6 border-b flex-shrink-0">
              <div className="flex items-start justify-between">
                <div className="space-y-1">
                  <div className="flex items-center gap-2">
                    <SheetTitle className="text-xl font-mono">
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
                    <span>Created {formatDate(sandbox.createdAt)}</span>
                  </div>
                </div>
                <Button
                  variant="destructive"
                  size="sm"
                  onClick={() => setIsDeleteDialogOpen(true)}
                >
                  <Trash2 className="h-4 w-4 mr-2" />
                  Delete
                </Button>
              </div>

              {sandbox.status === "running" && (
                <div className="flex items-center gap-2 mt-4">
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
                  <Button variant="outline" size="sm" asChild>
                    <a
                      href={sandbox.runtime.urls.ssh}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      <Key className="h-4 w-4 mr-2" />
                      SSH
                    </a>
                  </Button>
                </div>
              )}
            </SheetHeader>

            <ScrollArea className="flex-1">
              <div className="p-6 space-y-6">
                {sandbox.status === "running" && (
                  <>
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
                            <code className="block bg-muted p-3 rounded-md font-mono text-sm pr-10 overflow-x-auto whitespace-nowrap">
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
                            <code className="block bg-muted p-3 rounded-md font-mono text-sm pr-10 overflow-x-auto whitespace-nowrap">
                              code --remote ssh-remote+root@
                              {sandbox.runtime.ipAddress} /workspace
                            </code>
                            <Button
                              size="icon"
                              variant="ghost"
                              className="absolute right-1 top-1 h-7 w-7"
                              onClick={() =>
                                copyToClipboard(
                                  `code --remote ssh-remote+root@${sandbox.runtime.ipAddress} /workspace`,
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
                            <code className="block bg-muted p-3 rounded-md font-mono text-sm pr-10 overflow-x-auto whitespace-nowrap">
                              ssh root@{sandbox.runtime.ipAddress}
                            </code>
                            <Button
                              size="icon"
                              variant="ghost"
                              className="absolute right-1 top-1 h-7 w-7"
                              onClick={() =>
                                copyToClipboard(
                                  `ssh root@${sandbox.runtime.ipAddress}`,
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
              <div
                key={repo.path}
                className="flex items-start justify-between p-3 rounded-lg border bg-muted/30"
              >
                <div className="flex-1 min-w-0">
                  <div className="font-mono text-sm font-medium truncate">
                    {repo.path}
                  </div>
                  {repo.error ? (
                    <div className="text-xs text-destructive mt-1">
                      {repo.error}
                    </div>
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
                <div className="flex flex-col items-end gap-1.5 ml-3">
                  {repo.dirty && (
                    <Badge variant="warning" className="text-[10px] h-5 px-1.5">
                      Dirty
                    </Badge>
                  )}
                  {repo.ahead > 0 && (
                    <Badge
                      variant="secondary"
                      className="text-[10px] h-5 px-1.5"
                    >
                      +{repo.ahead}
                    </Badge>
                  )}
                  {repo.behind > 0 && (
                    <Badge
                      variant="secondary"
                      className="text-[10px] h-5 px-1.5"
                    >
                      -{repo.behind}
                    </Badge>
                  )}
                  {!repo.error && !repo.dirty && repo.ahead === 0 && (
                    <Badge variant="success" className="text-[10px] h-5 px-1.5">
                      Clean
                    </Badge>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
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
