import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import {
  ExternalLink,
  Eye,
  Loader2,
  Pause,
  Play,
  Plus,
  RotateCcw,
  Trash2,
} from "lucide-react";
import { useState } from "react";
import type { Sandbox } from "@/api/client";
import {
  sandboxListQuery,
  useCreateSandbox,
  useDeleteSandbox,
  useStartSandbox,
  useStopSandbox,
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
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { formatRelativeTime } from "@/lib/utils";

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
  const deleteMutation = useDeleteSandbox();
  const createMutation = useCreateSandbox();
  const stopMutation = useStopSandbox();
  const startMutation = useStartSandbox();

  const filteredSandboxes =
    statusFilter === "all"
      ? sandboxes
      : sandboxes.filter((s) => s.status === statusFilter);

  const handleDelete = (id: string) => {
    if (confirm(`Delete sandbox ${id}?`)) {
      deleteMutation.mutate(id);
    }
  };

  const handleRecreate = async (sandbox: Sandbox) => {
    if (!sandbox.projectId) return;
    if (
      !confirm(
        `This will delete the current sandbox and create a new one from project "${sandbox.projectId}". Continue?`,
      )
    ) {
      return;
    }

    setRecreatingId(sandbox.id);
    try {
      await deleteMutation.mutateAsync(sandbox.id);
      await createMutation.mutateAsync({
        projectId: sandbox.projectId,
        branch: sandbox.branch,
        async: true,
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
  onDelete,
  onRecreate,
  isRecreating,
  onStop,
  onStart,
  isStopping,
  isStarting,
}: {
  sandbox: Sandbox;
  onDelete: () => void;
  onRecreate?: () => void;
  isRecreating?: boolean;
  onStop?: () => void;
  onStart?: () => void;
  isStopping?: boolean;
  isStarting?: boolean;
}) {
  const statusVariant = {
    running: "success",
    creating: "warning",
    stopped: "secondary",
    error: "error",
  } as const;

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
          {sandbox.projectId && (
            <Badge variant="outline">{sandbox.projectId}</Badge>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {sandbox.status === "running" && (
            <>
              <Button variant="outline" size="sm" asChild>
                <a
                  href={sandbox.urls.vscode}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  <ExternalLink className="h-4 w-4 mr-1" />
                  VSCode
                </a>
              </Button>
              <Button variant="outline" size="sm" asChild>
                <a
                  href={sandbox.urls.opencode}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  <ExternalLink className="h-4 w-4 mr-1" />
                  OpenCode
                </a>
              </Button>
              {onStop && (
                <Tooltip>
                  <TooltipTrigger asChild>
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
                  </TooltipTrigger>
                  <TooltipContent>
                    <p>Pause the sandbox VM</p>
                  </TooltipContent>
                </Tooltip>
              )}
            </>
          )}
          {sandbox.status === "creating" && (
            <Button variant="outline" size="sm" disabled>
              <Loader2 className="h-4 w-4 mr-1 animate-spin" />
              Creating...
            </Button>
          )}
          {sandbox.status === "stopped" && onStart && (
            <Tooltip>
              <TooltipTrigger asChild>
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
              </TooltipTrigger>
              <TooltipContent>
                <p>Resume the sandbox VM</p>
              </TooltipContent>
            </Tooltip>
          )}
          {sandbox.status === "error" && sandbox.projectId && onRecreate && (
            <Tooltip>
              <TooltipTrigger asChild>
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
              </TooltipTrigger>
              <TooltipContent>
                <p>Delete and create a new sandbox from the same project</p>
              </TooltipContent>
            </Tooltip>
          )}
          <Button variant="outline" size="sm" asChild>
            <Link to="/sandboxes/$id" params={{ id: sandbox.id }}>
              <Eye className="h-4 w-4 mr-1" />
              Details
            </Link>
          </Button>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="ghost" size="icon" onClick={onDelete}>
                <Trash2 className="h-4 w-4 text-destructive" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>
              <p>Delete sandbox</p>
            </TooltipContent>
          </Tooltip>
        </div>
      </CardHeader>
      <CardContent>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
          <div>
            <span className="text-muted-foreground">IP Address</span>
            <p className="font-mono">{sandbox.ipAddress}</p>
          </div>
          <div>
            <span className="text-muted-foreground">Resources</span>
            <p>
              {sandbox.resources.vcpus} vCPU / {sandbox.resources.memoryMb}MB
            </p>
          </div>
          <div>
            <span className="text-muted-foreground">Created</span>
            <p>{formatRelativeTime(sandbox.createdAt)}</p>
          </div>
          {sandbox.branch && (
            <div>
              <span className="text-muted-foreground">Branch</span>
              <p className="font-mono">{sandbox.branch}</p>
            </div>
          )}
        </div>
        {sandbox.error && (
          <div className="mt-3 p-2 bg-destructive/10 rounded text-sm text-destructive">
            {sandbox.error}
          </div>
        )}
        {sandbox.status === "stopped" && !sandbox.projectId && (
          <div className="mt-3 p-2 bg-muted rounded text-sm text-muted-foreground">
            This sandbox is stopped and cannot be restarted. You can delete it
            or create a new one.
          </div>
        )}
      </CardContent>
    </Card>
  );
}
