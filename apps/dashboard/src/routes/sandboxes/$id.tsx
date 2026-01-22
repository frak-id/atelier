import { useQuery, useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import {
  AlertTriangle,
  ArrowLeft,
  Check,
  ChevronDown,
  Copy,
  Cpu,
  ExternalLink,
  FileCode,
  GitBranch,
  HardDrive,
  Loader2,
  MemoryStick,
  MessageSquare,
  Pause,
  Play,
  RefreshCw,
  Save,
  Terminal,
  Trash2,
} from "lucide-react";
import { useCallback, useState } from "react";
import {
  opencodeSessionsQuery,
  sandboxDetailQuery,
  sandboxDiscoverConfigsQuery,
  sandboxGitStatusQuery,
  sandboxMetricsQuery,
  sandboxServicesQuery,
  useDeleteOpenCodeSession,
  useDeleteSandbox,
  useExecCommand,
  useExtractConfig,
  useResizeStorage,
  useSaveAsPrebuild,
  useStartSandbox,
  useStopSandbox,
  workspaceDetailQuery,
} from "@/api/queries";

import { HierarchicalSessionList } from "@/components/hierarchical-session-list";
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
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { formatBytes, formatDate } from "@/lib/utils";

export const Route = createFileRoute("/sandboxes/$id")({
  component: SandboxDetailPage,
  loader: ({ context, params }) => {
    context.queryClient.ensureQueryData(sandboxDetailQuery(params.id));
  },
  pendingComponent: () => (
    <div className="p-6 space-y-6">
      <Skeleton className="h-8 w-64" />
      <Skeleton className="h-64" />
    </div>
  ),
});

function SandboxDetailPage() {
  const { id } = Route.useParams();
  const navigate = Route.useNavigate();
  const { data: sandbox } = useSuspenseQuery(sandboxDetailQuery(id));

  const deleteMutation = useDeleteSandbox();
  const stopMutation = useStopSandbox();
  const startMutation = useStartSandbox();
  const saveAsPrebuildMutation = useSaveAsPrebuild();
  const [command, setCommand] = useState("");
  const [execOutput, setExecOutput] = useState<{
    stdout: string;
    stderr: string;
    exitCode: number;
  } | null>(null);
  const [showSaveAsPrebuildDialog, setShowSaveAsPrebuildDialog] =
    useState(false);
  const execMutation = useExecCommand(id);

  const { data: metrics } = useQuery({
    ...sandboxMetricsQuery(id),
    enabled: sandbox?.status === "running",
  });
  const { data: services } = useQuery({
    ...sandboxServicesQuery(id),
    enabled: sandbox?.status === "running",
  });
  const { data: workspace } = useQuery({
    ...workspaceDetailQuery(sandbox?.workspaceId ?? ""),
    enabled: !!sandbox?.workspaceId,
  });

  if (!sandbox) {
    return (
      <div className="p-6">
        <p className="text-muted-foreground">Sandbox not found</p>
      </div>
    );
  }

  const handleDelete = () => {
    if (confirm(`Delete sandbox ${id}?`)) {
      deleteMutation.mutate(id, {
        onSuccess: () => navigate({ to: "/sandboxes" }),
      });
    }
  };

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

  const statusVariant = {
    running: "success",
    creating: "warning",
    stopped: "secondary",
    error: "error",
  } as const;

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center gap-4">
        <Button variant="ghost" size="icon" asChild>
          <Link to="/sandboxes">
            <ArrowLeft className="h-4 w-4" />
          </Link>
        </Button>
        <div className="flex-1">
          <div className="flex items-center gap-3">
            <h1 className="text-3xl font-bold">{sandbox.id}</h1>
            <Badge variant={statusVariant[sandbox.status]}>
              {sandbox.status}
            </Badge>
          </div>
          <p className="text-muted-foreground">
            Created {formatDate(sandbox.createdAt)}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {sandbox.status === "running" && (
            <>
              <Button variant="outline" asChild>
                <a
                  href={sandbox.runtime.urls.vscode}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  <ExternalLink className="h-4 w-4 mr-2" />
                  VSCode
                </a>
              </Button>
              <Button variant="outline" asChild>
                <a
                  href={sandbox.runtime.urls.opencode}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  <ExternalLink className="h-4 w-4 mr-2" />
                  OpenCode
                </a>
              </Button>
              <Button
                variant="outline"
                onClick={() => stopMutation.mutate(id)}
                disabled={stopMutation.isPending}
              >
                {stopMutation.isPending ? (
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                ) : (
                  <Pause className="h-4 w-4 mr-2" />
                )}
                Stop
              </Button>
              {sandbox.workspaceId && (
                <Button
                  variant="outline"
                  onClick={() => setShowSaveAsPrebuildDialog(true)}
                  disabled={saveAsPrebuildMutation.isPending}
                >
                  {saveAsPrebuildMutation.isPending ? (
                    <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  ) : (
                    <Save className="h-4 w-4 mr-2" />
                  )}
                  Save as Prebuild
                </Button>
              )}
            </>
          )}
          {sandbox.status === "stopped" && (
            <Button
              variant="outline"
              onClick={() => startMutation.mutate(id)}
              disabled={startMutation.isPending}
            >
              {startMutation.isPending ? (
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
              ) : (
                <Play className="h-4 w-4 mr-2" />
              )}
              Start
            </Button>
          )}
          <Button variant="destructive" onClick={handleDelete}>
            <Trash2 className="h-4 w-4 mr-2" />
            Delete
          </Button>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <Card>
          <CardHeader>
            <CardTitle>Details</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {sandbox.workspaceId && (
              <div className="flex justify-between items-center">
                <span className="text-muted-foreground">Workspace</span>
                <Link
                  to="/workspaces/$id"
                  params={{ id: sandbox.workspaceId }}
                  className="text-primary hover:underline font-medium"
                >
                  {workspace?.name ?? sandbox.workspaceId}
                </Link>
              </div>
            )}
            <CopyableRow label="ID" value={sandbox.id} />
            <div className="flex justify-between items-center">
              <span className="text-muted-foreground">Resources</span>
              <div className="flex items-center gap-3">
                <span className="flex items-center gap-1">
                  <Cpu className="h-3.5 w-3.5 text-muted-foreground" />
                  {sandbox.runtime.vcpus} vCPU
                </span>
                <span className="flex items-center gap-1">
                  <MemoryStick className="h-3.5 w-3.5 text-muted-foreground" />
                  {sandbox.runtime.memoryMb}MB
                </span>
              </div>
            </div>

            <TechnicalDetails
              ipAddress={sandbox.runtime.ipAddress}
              macAddress={sandbox.runtime.macAddress}
              pid={sandbox.runtime.pid}
            />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>URLs</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <UrlRow label="VSCode" url={sandbox.runtime.urls.vscode} />
            <UrlRow label="OpenCode" url={sandbox.runtime.urls.opencode} />
            <UrlRow label="Terminal" url={sandbox.runtime.urls.terminal} />
          </CardContent>
        </Card>

        {sandbox.status === "running" && metrics && (
          <ResourcesCard sandboxId={id} metrics={metrics} />
        )}
      </div>

      {sandbox.status === "running" && (
        <Tabs defaultValue="repos">
          <TabsList>
            <TabsTrigger value="repos">Repositories</TabsTrigger>
            <TabsTrigger value="services">Services</TabsTrigger>
            <TabsTrigger value="opencode">OpenCode Sessions</TabsTrigger>

            <TabsTrigger value="exec">Exec</TabsTrigger>
            {sandbox.workspaceId && (
              <TabsTrigger value="config">Extract Config</TabsTrigger>
            )}
          </TabsList>

          <TabsContent value="repos">
            <RepositoriesTab sandboxId={id} />
          </TabsContent>

          <TabsContent value="services">
            <Card>
              <CardHeader>
                <CardTitle>Services</CardTitle>
              </CardHeader>
              <CardContent>
                {services?.services ? (
                  <div className="space-y-2">
                    {services.services.map((service) => (
                      <div
                        key={service.name}
                        className="flex items-center justify-between py-2 border-b last:border-0"
                      >
                        <span>{service.name}</span>
                        <div className="flex items-center gap-2">
                          {service.pid && (
                            <span className="text-sm text-muted-foreground">
                              PID: {service.pid}
                            </span>
                          )}
                          <Badge
                            variant={service.running ? "success" : "error"}
                          >
                            {service.running ? "Running" : "Stopped"}
                          </Badge>
                        </div>
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="text-muted-foreground">Loading services...</p>
                )}
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="opencode">
            <OpenCodeSessions
              sandboxId={sandbox.id}
              workspaceId={sandbox.workspaceId}
              opencodeUrl={sandbox.runtime.urls.opencode}
            />
          </TabsContent>

          <TabsContent value="exec">
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <Terminal className="h-5 w-5" />
                  Execute Command
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="flex gap-2">
                  <Input
                    placeholder="Enter command..."
                    value={command}
                    onChange={(e) => setCommand(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && handleExec()}
                    className="font-mono"
                  />
                  <Button
                    onClick={handleExec}
                    disabled={execMutation.isPending || !command.trim()}
                  >
                    {execMutation.isPending ? (
                      <RefreshCw className="h-4 w-4 animate-spin" />
                    ) : (
                      <Play className="h-4 w-4" />
                    )}
                  </Button>
                </div>
                {execOutput && (
                  <div className="bg-black rounded-lg p-4 font-mono text-sm text-green-400">
                    <div className="flex items-center justify-between mb-2 text-xs text-muted-foreground">
                      <span>Exit code: {execOutput.exitCode}</span>
                    </div>
                    {execOutput.stdout && (
                      <pre className="whitespace-pre-wrap">
                        {execOutput.stdout}
                      </pre>
                    )}
                    {execOutput.stderr && (
                      <pre className="whitespace-pre-wrap text-red-400">
                        {execOutput.stderr}
                      </pre>
                    )}
                  </div>
                )}
              </CardContent>
            </Card>
          </TabsContent>

          {sandbox.workspaceId && (
            <TabsContent value="config">
              <ConfigExtractor
                sandboxId={id}
                workspaceId={sandbox.workspaceId}
              />
            </TabsContent>
          )}
        </Tabs>
      )}

      {sandbox.runtime.error && (
        <Card className="border-destructive">
          <CardHeader>
            <CardTitle className="text-destructive">Error</CardTitle>
          </CardHeader>
          <CardContent>
            <pre className="whitespace-pre-wrap text-sm">
              {sandbox.runtime.error}
            </pre>
          </CardContent>
        </Card>
      )}

      <Dialog
        open={showSaveAsPrebuildDialog}
        onOpenChange={setShowSaveAsPrebuildDialog}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <AlertTriangle className="h-5 w-5 text-yellow-500" />
              Save as Prebuild
            </DialogTitle>
            <DialogDescription>
              This will save the current state of this sandbox as the prebuild
              for workspace{" "}
              <span className="font-semibold">
                {workspace?.name ?? sandbox.workspaceId}
              </span>
              .
              {workspace?.config.prebuild?.status === "ready" && (
                <span className="block mt-2 text-yellow-600">
                  This will replace the existing prebuild image.
                </span>
              )}
            </DialogDescription>
          </DialogHeader>
          <div className="text-sm text-muted-foreground">
            <p>The sandbox will be temporarily stopped during the snapshot.</p>
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setShowSaveAsPrebuildDialog(false)}
            >
              Cancel
            </Button>
            <Button
              onClick={() => {
                saveAsPrebuildMutation.mutate(id, {
                  onSuccess: () => setShowSaveAsPrebuildDialog(false),
                });
              }}
              disabled={saveAsPrebuildMutation.isPending}
            >
              {saveAsPrebuildMutation.isPending ? (
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
              ) : (
                <Save className="h-4 w-4 mr-2" />
              )}
              Save as Prebuild
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function OpenCodeSessions({
  sandboxId,
  workspaceId,
  opencodeUrl,
}: {
  sandboxId: string;
  workspaceId: string | undefined;
  opencodeUrl: string;
}) {
  const { data: sessions, isLoading } = useQuery(
    opencodeSessionsQuery(opencodeUrl),
  );
  const deleteMutation = useDeleteOpenCodeSession(opencodeUrl);

  if (isLoading) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <MessageSquare className="h-5 w-5" />
            OpenCode Sessions
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex items-center gap-2 text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            Loading sessions...
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <MessageSquare className="h-5 w-5" />
          OpenCode Sessions
        </CardTitle>
      </CardHeader>
      <CardContent>
        {sessions && sessions.length > 0 ? (
          <HierarchicalSessionList
            sessions={sessions.map((session) => ({
              ...session,
              sandbox: { id: sandboxId, workspaceId, opencodeUrl },
            }))}
            showDelete
            onDelete={(sessionId) => deleteMutation.mutate(sessionId)}
            isDeleting={deleteMutation.isPending}
          />
        ) : (
          <div className="text-center py-8 text-muted-foreground">
            <MessageSquare className="h-12 w-12 mx-auto mb-3 opacity-50" />
            <p>No OpenCode sessions yet</p>
            <p className="text-sm mt-1">
              Start a session by opening the OpenCode terminal in this sandbox
            </p>
            <Button variant="outline" className="mt-4" asChild>
              <a href={opencodeUrl} target="_blank" rel="noopener noreferrer">
                <ExternalLink className="h-4 w-4 mr-2" />
                Open OpenCode
              </a>
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function ConfigExtractor({
  sandboxId,
  workspaceId,
}: {
  sandboxId: string;
  workspaceId: string;
}) {
  const { data, isLoading, refetch } = useQuery(
    sandboxDiscoverConfigsQuery(sandboxId),
  );
  const extractMutation = useExtractConfig(sandboxId);
  const [extractedPaths, setExtractedPaths] = useState<Set<string>>(new Set());

  const configs = data?.configs ?? [];

  const handleExtract = (path: string) => {
    extractMutation.mutate(path, {
      onSuccess: () => {
        setExtractedPaths((prev) => new Set(prev).add(path));
      },
    });
  };

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between">
        <CardTitle className="flex items-center gap-2">
          <FileCode className="h-5 w-5" />
          Extract Config to Workspace
        </CardTitle>
        <Button variant="outline" size="sm" onClick={() => refetch()}>
          <RefreshCw className="h-4 w-4 mr-1" />
          Refresh
        </Button>
      </CardHeader>
      <CardContent>
        <p className="text-sm text-muted-foreground mb-4">
          Extract config files from this sandbox to save as workspace-specific
          configuration. These will be applied to new sandboxes created from{" "}
          <Link
            to="/workspaces/$id"
            params={{ id: workspaceId }}
            className="text-primary hover:underline"
          >
            this workspace
          </Link>
          .
        </p>

        {isLoading ? (
          <div className="flex items-center gap-2 text-muted-foreground py-8 justify-center">
            <Loader2 className="h-4 w-4 animate-spin" />
            Discovering config files...
          </div>
        ) : configs.length === 0 ? (
          <div className="text-center py-8 text-muted-foreground">
            <FileCode className="h-12 w-12 mx-auto mb-3 opacity-50" />
            <p>No config files found</p>
            <p className="text-sm mt-1">
              Create some configs in OpenCode or VSCode first
            </p>
          </div>
        ) : (
          <div className="space-y-2">
            {configs.map((config) => (
              <div
                key={config.path}
                className={`flex items-center justify-between p-3 rounded-lg border ${
                  config.exists ? "bg-muted/50" : "bg-muted/20 opacity-60"
                }`}
              >
                <div className="flex-1">
                  <div className="font-mono text-sm">{config.displayPath}</div>
                  <div className="text-xs text-muted-foreground">
                    {config.category} • {config.exists ? "exists" : "not found"}
                    {config.size !== undefined &&
                      ` • ${(config.size / 1024).toFixed(1)} KB`}
                  </div>
                </div>
                <Button
                  size="sm"
                  variant={
                    extractedPaths.has(config.path) ? "outline" : "default"
                  }
                  disabled={!config.exists || extractMutation.isPending}
                  onClick={() => handleExtract(config.path)}
                >
                  {extractMutation.isPending ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : extractedPaths.has(config.path) ? (
                    <>
                      <Check className="h-4 w-4 mr-1" />
                      Saved
                    </>
                  ) : (
                    "Extract"
                  )}
                </Button>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function RepositoriesTab({ sandboxId }: { sandboxId: string }) {
  const { data, isLoading, refetch } = useQuery(
    sandboxGitStatusQuery(sandboxId),
  );

  const repos = data?.repos ?? [];

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between">
        <CardTitle className="flex items-center gap-2">
          <GitBranch className="h-5 w-5" />
          Repositories
        </CardTitle>
        <Button variant="outline" size="sm" onClick={() => refetch()}>
          <RefreshCw className="h-4 w-4 mr-1" />
          Refresh
        </Button>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <div className="flex items-center gap-2 text-muted-foreground py-8 justify-center">
            <Loader2 className="h-4 w-4 animate-spin" />
            Loading repositories...
          </div>
        ) : repos.length === 0 ? (
          <div className="text-center py-8 text-muted-foreground">
            <GitBranch className="h-12 w-12 mx-auto mb-3 opacity-50" />
            <p>No repositories configured</p>
          </div>
        ) : (
          <div className="space-y-3">
            {repos.map((repo) => (
              <div
                key={repo.path}
                className="flex items-center justify-between p-4 rounded-lg border bg-muted/30"
              >
                <div className="flex-1">
                  <div className="font-mono text-sm font-medium">
                    {repo.path}
                  </div>
                  {repo.error ? (
                    <div className="text-sm text-destructive">{repo.error}</div>
                  ) : (
                    <div className="flex items-center gap-3 mt-1">
                      {repo.branch && (
                        <div className="flex items-center gap-1 text-sm">
                          <GitBranch className="h-3 w-3" />
                          <span className="font-mono">{repo.branch}</span>
                        </div>
                      )}
                      {repo.lastCommit && (
                        <span className="text-xs text-muted-foreground truncate max-w-[300px]">
                          {repo.lastCommit}
                        </span>
                      )}
                    </div>
                  )}
                </div>
                <div className="flex items-center gap-2">
                  {repo.dirty && (
                    <Badge variant="warning">Uncommitted changes</Badge>
                  )}
                  {repo.ahead > 0 && (
                    <Badge variant="secondary">{repo.ahead} ahead</Badge>
                  )}
                  {repo.behind > 0 && (
                    <Badge variant="secondary">{repo.behind} behind</Badge>
                  )}
                  {!repo.error && !repo.dirty && repo.ahead === 0 && (
                    <Badge variant="success">Clean</Badge>
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

function ResourcesCard({
  sandboxId,
  metrics,
}: {
  sandboxId: string;
  metrics: {
    cpu: number;
    memory: { total: number; used: number };
    disk: { total: number; used: number };
  };
}) {
  const [showResize, setShowResize] = useState(false);
  const [newSizeGb, setNewSizeGb] = useState("");
  const resizeMutation = useResizeStorage(sandboxId);

  const currentSizeGb = Math.round(metrics.disk.total / 1024 / 1024 / 1024);
  const diskUsagePercent = (metrics.disk.used / metrics.disk.total) * 100;

  const handleResize = () => {
    const size = parseInt(newSizeGb, 10);
    if (size > currentSizeGb && size <= 100) {
      resizeMutation.mutate(size, {
        onSuccess: () => {
          setShowResize(false);
          setNewSizeGb("");
        },
      });
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Resources</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div>
          <div className="flex justify-between text-sm mb-1">
            <span>CPU</span>
            <span>{metrics.cpu.toFixed(1)}%</span>
          </div>
          <div className="h-2 bg-secondary rounded-full overflow-hidden">
            <div
              className="h-full bg-primary transition-all"
              style={{ width: `${Math.min(metrics.cpu, 100)}%` }}
            />
          </div>
        </div>
        <div>
          <div className="flex justify-between text-sm mb-1">
            <span>Memory</span>
            <span>
              {formatBytes(metrics.memory.used)} /{" "}
              {formatBytes(metrics.memory.total)}
            </span>
          </div>
          <div className="h-2 bg-secondary rounded-full overflow-hidden">
            <div
              className="h-full bg-primary transition-all"
              style={{
                width: `${(metrics.memory.used / metrics.memory.total) * 100}%`,
              }}
            />
          </div>
        </div>
        <div>
          <div className="flex justify-between text-sm mb-1">
            <div className="flex items-center gap-2">
              <span>Disk</span>
              {!showResize && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-5 px-2 text-xs"
                  onClick={() => setShowResize(true)}
                >
                  <HardDrive className="h-3 w-3 mr-1" />
                  Resize
                </Button>
              )}
            </div>
            <span>
              {formatBytes(metrics.disk.used)} /{" "}
              {formatBytes(metrics.disk.total)}
            </span>
          </div>
          <div className="h-2 bg-secondary rounded-full overflow-hidden">
            <div
              className={`h-full transition-all ${diskUsagePercent > 90 ? "bg-destructive" : diskUsagePercent > 70 ? "bg-yellow-500" : "bg-primary"}`}
              style={{ width: `${diskUsagePercent}%` }}
            />
          </div>
          {showResize && (
            <div className="mt-3 flex items-center gap-2">
              <Input
                type="number"
                placeholder={`New size (>${currentSizeGb}GB)`}
                value={newSizeGb}
                onChange={(e) => setNewSizeGb(e.target.value)}
                className="w-32 h-8"
                min={currentSizeGb + 1}
                max={100}
              />
              <span className="text-sm text-muted-foreground">GB</span>
              <Button
                size="sm"
                onClick={handleResize}
                disabled={
                  resizeMutation.isPending ||
                  !newSizeGb ||
                  parseInt(newSizeGb, 10) <= currentSizeGb
                }
              >
                {resizeMutation.isPending ? (
                  <Loader2 className="h-3 w-3 animate-spin" />
                ) : (
                  "Apply"
                )}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  setShowResize(false);
                  setNewSizeGb("");
                }}
              >
                Cancel
              </Button>
            </div>
          )}
          {resizeMutation.isError && (
            <p className="text-sm text-destructive mt-2">
              Resize failed: {String(resizeMutation.error)}
            </p>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

function CopyableRow({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback(() => {
    navigator.clipboard.writeText(value);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }, [value]);

  return (
    <div className="flex justify-between items-center">
      <span className="text-muted-foreground">{label}</span>
      <div className="flex items-center gap-1.5">
        <code className="font-mono text-sm">{value}</code>
        <Button
          variant="ghost"
          size="icon"
          className="h-6 w-6"
          onClick={handleCopy}
        >
          {copied ? (
            <Check className="h-3 w-3 text-green-500" />
          ) : (
            <Copy className="h-3 w-3 text-muted-foreground" />
          )}
        </Button>
      </div>
    </div>
  );
}

function TechnicalDetails({
  ipAddress,
  macAddress,
  pid,
}: {
  ipAddress: string;
  macAddress: string;
  pid?: number;
}) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="border-t pt-3 mt-1">
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        className="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground transition-colors w-full"
      >
        <ChevronDown
          className={`h-4 w-4 transition-transform ${expanded ? "rotate-0" : "-rotate-90"}`}
        />
        Technical Details
      </button>
      {expanded && (
        <div className="mt-3 space-y-2 text-sm">
          <div className="flex justify-between">
            <span className="text-muted-foreground">IP Address</span>
            <code className="font-mono">{ipAddress}</code>
          </div>
          <div className="flex justify-between">
            <span className="text-muted-foreground">MAC Address</span>
            <code className="font-mono">{macAddress}</code>
          </div>
          {pid && (
            <div className="flex justify-between">
              <span className="text-muted-foreground">PID</span>
              <code className="font-mono">{pid}</code>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function UrlRow({ label, url }: { label: string; url: string }) {
  return (
    <div className="flex justify-between items-center">
      <span className="text-muted-foreground">{label}</span>
      <a
        href={url}
        target="_blank"
        rel="noopener noreferrer"
        className="text-primary hover:underline flex items-center gap-1"
      >
        Open <ExternalLink className="h-3 w-3" />
      </a>
    </div>
  );
}
