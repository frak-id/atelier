import { useQuery, useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import {
  AlertTriangle,
  Check,
  Copy,
  ExternalLink,
  Eye,
  Loader2,
  Pause,
  Play,
  Plus,
  RotateCcw,
  Trash2,
} from "lucide-react";
import { useCallback, useState } from "react";
import type { Sandbox } from "@/api/client";
import {
  sandboxListQuery,
  sshKeysHasKeysQuery,
  useCreateSandbox,
  useDeleteSandbox,
  useStartSandbox,
  useStopSandbox,
  useWorkspaceMap,
} from "@/api/queries";
import { CreateSandboxDialog } from "@/components/create-sandbox-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { formatRelativeTime } from "@/lib/utils";

function useCopyToClipboard() {
  const [copiedKey, setCopiedKey] = useState<string | null>(null);

  const copy = useCallback((text: string, key: string) => {
    navigator.clipboard.writeText(text);
    setCopiedKey(key);
    setTimeout(() => setCopiedKey(null), 2000);
  }, []);

  return { copy, isCopied: (key: string) => copiedKey === key };
}

import { SSH_KEY_PATH } from "@/components/ssh-keys-section";

function sshCommandToVscodeRemote(sshCmd: string): string {
  const withoutSsh = sshCmd.replace(/^ssh\s+/, "");
  const [userHost, port] = withoutSsh.split(/\s+-p\s+/);
  const remoteHost = port ? `${userHost}:${port}` : userHost;
  return `code --remote ssh-remote+${remoteHost} /workspace`;
}

function getSshCommand(sshCmd: string): string {
  return `${sshCmd} -i ${SSH_KEY_PATH}`;
}

export const Route = createFileRoute("/sandboxes/")({
  component: SandboxesPage,
  loader: ({ context }) => {
    context.queryClient.ensureQueryData(sandboxListQuery());
  },
  pendingComponent: () => (
    <div className="p-6 space-y-6">
      <Skeleton className="h-9 w-48" />
      <div className="grid gap-4">
        {[...Array(3)].map((_, i) => (
          <Skeleton key={i} className="h-32" />
        ))}
      </div>
    </div>
  ),
});

function SandboxesPage() {
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [createOpen, setCreateOpen] = useState(false);
  const [recreatingId, setRecreatingId] = useState<string | null>(null);
  const { data: sandboxes } = useSuspenseQuery(sandboxListQuery());
  const { data: hasKeysData } = useQuery(sshKeysHasKeysQuery);
  const workspaceMap = useWorkspaceMap();
  const deleteMutation = useDeleteSandbox();
  const createMutation = useCreateSandbox();
  const stopMutation = useStopSandbox();
  const startMutation = useStartSandbox();

  const filteredSandboxes =
    statusFilter === "all"
      ? (sandboxes ?? [])
      : (sandboxes ?? []).filter((s) => s.status === statusFilter);

  const handleDelete = (id: string) => {
    if (confirm(`Delete sandbox ${id}?`)) {
      deleteMutation.mutate(id);
    }
  };

  const handleRecreate = async (sandbox: Sandbox) => {
    if (!sandbox.workspaceId) return;
    if (
      !confirm(
        `This will delete the current sandbox and create a new one from workspace "${sandbox.workspaceId}". Continue?`,
      )
    ) {
      return;
    }

    setRecreatingId(sandbox.id);
    try {
      await deleteMutation.mutateAsync(sandbox.id);
      await createMutation.mutateAsync({
        workspaceId: sandbox.workspaceId,
      });
    } finally {
      setRecreatingId(null);
    }
  };

  return (
    <div className="p-6 space-y-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold sm:text-3xl">Sandboxes</h1>
          <p className="text-muted-foreground">
            Manage your development environments
          </p>
        </div>
        <Button
          onClick={() => setCreateOpen(true)}
          className="w-full sm:w-auto"
        >
          <Plus className="h-4 w-4 mr-2" />
          New Sandbox
        </Button>
      </div>

      {hasKeysData?.hasKeys === false && (
        <Card className="border-amber-500/50 bg-amber-500/10">
          <CardContent className="flex items-center gap-3 py-4">
            <AlertTriangle className="h-5 w-5 text-amber-500 shrink-0" />
            <div className="flex-1">
              <p className="text-sm font-medium">SSH keys not configured</p>
              <p className="text-sm text-muted-foreground">
                You won't be able to SSH into sandboxes until you configure your
                SSH keys.
              </p>
            </div>
            <Button variant="outline" size="sm" asChild>
              <Link to="/settings">Configure SSH Keys</Link>
            </Button>
          </CardContent>
        </Card>
      )}

      <div className="flex flex-wrap items-center gap-4">
        <Select value={statusFilter} onValueChange={setStatusFilter}>
          <SelectTrigger className="w-full sm:w-40">
            <SelectValue placeholder="Filter by status" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All</SelectItem>
            <SelectItem value="running">Running</SelectItem>
            <SelectItem value="creating">Creating</SelectItem>
            <SelectItem value="stopped">Stopped</SelectItem>
            <SelectItem value="error">Error</SelectItem>
          </SelectContent>
        </Select>
        <span className="text-sm text-muted-foreground">
          {filteredSandboxes.length} sandbox
          {filteredSandboxes.length !== 1 ? "es" : ""}
        </span>
      </div>

      {filteredSandboxes.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center justify-center py-12">
            <p className="text-muted-foreground mb-4">No sandboxes found</p>
            <Button onClick={() => setCreateOpen(true)}>
              <Plus className="h-4 w-4 mr-2" />
              Create your first sandbox
            </Button>
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-4">
          {filteredSandboxes.map((sandbox) => (
            <SandboxCard
              key={sandbox.id}
              sandbox={sandbox}
              workspaceName={
                sandbox.workspaceId
                  ? workspaceMap.get(sandbox.workspaceId)
                  : undefined
              }
              onDelete={() => handleDelete(sandbox.id)}
              onRecreate={() => handleRecreate(sandbox)}
              isRecreating={recreatingId === sandbox.id}
              onStop={() => stopMutation.mutate(sandbox.id)}
              onStart={() => startMutation.mutate(sandbox.id)}
              isStopping={
                stopMutation.isPending && stopMutation.variables === sandbox.id
              }
              isStarting={
                startMutation.isPending &&
                startMutation.variables === sandbox.id
              }
            />
          ))}
        </div>
      )}

      <CreateSandboxDialog open={createOpen} onOpenChange={setCreateOpen} />
    </div>
  );
}

function SandboxCard({
  sandbox,
  workspaceName,
  onDelete,
  onRecreate,
  isRecreating,
  onStop,
  onStart,
  isStopping,
  isStarting,
}: {
  sandbox: Sandbox;
  workspaceName?: string;
  onDelete: () => void;
  onRecreate?: () => void;
  isRecreating?: boolean;
  onStop?: () => void;
  onStart?: () => void;
  isStopping?: boolean;
  isStarting?: boolean;
}) {
  const { copy, isCopied } = useCopyToClipboard();

  const statusVariant = {
    running: "success",
    creating: "warning",
    stopped: "secondary",
    error: "error",
  } as const;

  const opencodeAttachCmd = `opencode attach ${sandbox.runtime.urls.opencode}`;
  const sshCmd = getSshCommand(sandbox.runtime.urls.ssh);
  const vscodeRemoteCmd = sshCommandToVscodeRemote(sandbox.runtime.urls.ssh);

  return (
    <Card>
      <CardHeader className="flex flex-col gap-3 pb-2 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex flex-wrap items-center gap-2">
          <Link to="/sandboxes/$id" params={{ id: sandbox.id }}>
            <CardTitle className="hover:underline cursor-pointer">
              {sandbox.id}
            </CardTitle>
          </Link>
          <Badge variant={statusVariant[sandbox.status]}>
            {sandbox.status}
          </Badge>
          {sandbox.workspaceId && (
            <Badge variant="outline">
              {workspaceName ?? sandbox.workspaceId}
            </Badge>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {sandbox.status === "running" && onStop && (
            <Button
              variant="outline"
              size="sm"
              onClick={onStop}
              disabled={isStopping}
            >
              {isStopping ? (
                <Loader2 className="h-4 w-4 mr-1 animate-spin" />
              ) : (
                <Pause className="h-4 w-4 mr-1" />
              )}
              Stop
            </Button>
          )}
          {sandbox.status === "creating" && (
            <Button variant="outline" size="sm" disabled>
              <Loader2 className="h-4 w-4 mr-1 animate-spin" />
              Creating...
            </Button>
          )}
          {sandbox.status === "stopped" && onStart && (
            <Button
              variant="outline"
              size="sm"
              onClick={onStart}
              disabled={isStarting}
            >
              {isStarting ? (
                <Loader2 className="h-4 w-4 mr-1 animate-spin" />
              ) : (
                <Play className="h-4 w-4 mr-1" />
              )}
              Start
            </Button>
          )}
          {sandbox.status === "error" && sandbox.workspaceId && onRecreate && (
            <Button
              variant="outline"
              size="sm"
              onClick={onRecreate}
              disabled={isRecreating}
            >
              {isRecreating ? (
                <Loader2 className="h-4 w-4 mr-1 animate-spin" />
              ) : (
                <RotateCcw className="h-4 w-4 mr-1" />
              )}
              Recreate
            </Button>
          )}
          <Button variant="outline" size="sm" asChild>
            <Link to="/sandboxes/$id" params={{ id: sandbox.id }}>
              <Eye className="h-4 w-4 mr-1" />
              Details
            </Link>
          </Button>
          <Button variant="ghost" size="icon" onClick={onDelete}>
            <Trash2 className="h-4 w-4 text-destructive" />
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {sandbox.status === "running" && (
          <div className="space-y-2">
            <span className="text-sm text-muted-foreground">Quick Connect</span>
            <div className="space-y-1.5">
              <div className="flex items-center gap-2 group">
                <code className="flex-1 text-xs bg-muted px-2 py-1.5 rounded font-mono truncate">
                  {opencodeAttachCmd}
                </code>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7 shrink-0"
                  onClick={() => copy(opencodeAttachCmd, "opencode")}
                >
                  {isCopied("opencode") ? (
                    <Check className="h-3.5 w-3.5 text-green-500" />
                  ) : (
                    <Copy className="h-3.5 w-3.5" />
                  )}
                </Button>
              </div>
              <div className="flex items-center gap-2 group">
                <code className="flex-1 text-xs bg-muted px-2 py-1.5 rounded font-mono truncate">
                  {sshCmd}
                </code>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7 shrink-0"
                  onClick={() => copy(sshCmd, "ssh")}
                >
                  {isCopied("ssh") ? (
                    <Check className="h-3.5 w-3.5 text-green-500" />
                  ) : (
                    <Copy className="h-3.5 w-3.5" />
                  )}
                </Button>
              </div>
              <div className="flex items-center gap-2 group">
                <code className="flex-1 text-xs bg-muted px-2 py-1.5 rounded font-mono truncate">
                  {vscodeRemoteCmd}
                </code>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7 shrink-0"
                  onClick={() => copy(vscodeRemoteCmd, "vscode")}
                >
                  {isCopied("vscode") ? (
                    <Check className="h-3.5 w-3.5 text-green-500" />
                  ) : (
                    <Copy className="h-3.5 w-3.5" />
                  )}
                </Button>
              </div>
            </div>
            <div className="flex gap-2 pt-1">
              <a
                href={sandbox.runtime.urls.opencode}
                target="_blank"
                rel="noopener noreferrer"
                className="text-xs text-muted-foreground hover:text-foreground inline-flex items-center gap-1"
              >
                <ExternalLink className="h-3 w-3" />
                OpenCode Web
              </a>
              <a
                href={sandbox.runtime.urls.vscode}
                target="_blank"
                rel="noopener noreferrer"
                className="text-xs text-muted-foreground hover:text-foreground inline-flex items-center gap-1"
              >
                <ExternalLink className="h-3 w-3" />
                VSCode Web
              </a>
            </div>
          </div>
        )}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
          <div>
            <span className="text-muted-foreground">IP Address</span>
            <p className="font-mono">{sandbox.runtime.ipAddress}</p>
          </div>
          <div>
            <span className="text-muted-foreground">Resources</span>
            <p>
              {sandbox.runtime.vcpus} vCPU / {sandbox.runtime.memoryMb}MB
            </p>
          </div>
          <div>
            <span className="text-muted-foreground">Created</span>
            <p>{formatRelativeTime(sandbox.createdAt)}</p>
          </div>
          {sandbox.workspaceId && (
            <div>
              <span className="text-muted-foreground">Workspace</span>
              <p>{workspaceName ?? sandbox.workspaceId}</p>
            </div>
          )}
        </div>
        {sandbox.runtime.error && (
          <div className="p-2 bg-destructive/10 rounded text-sm text-destructive">
            {sandbox.runtime.error}
          </div>
        )}
        {sandbox.status === "stopped" && !sandbox.workspaceId && (
          <div className="p-2 bg-muted rounded text-sm text-muted-foreground">
            This sandbox is stopped and cannot be restarted. You can delete it
            or create a new one.
          </div>
        )}
      </CardContent>
    </Card>
  );
}
