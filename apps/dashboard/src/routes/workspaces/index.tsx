import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { FolderGit2, Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import type { Workspace } from "@/api/client";
import { useDeleteWorkspace, workspaceListQuery } from "@/api/queries";
import { CreateWorkspaceDialog } from "@/components/create-workspace-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";

export const Route = createFileRoute("/workspaces/")({
  component: WorkspacesPage,
  loader: ({ context }) => {
    context.queryClient.ensureQueryData(workspaceListQuery());
  },
  pendingComponent: () => (
    <div className="p-6 space-y-6">
      <Skeleton className="h-9 w-48" />
      <div className="grid gap-4">
        {[...Array(3)].map((_, i) => (
          <Skeleton key={`skeleton-${i}`} className="h-40" />
        ))}
      </div>
    </div>
  ),
});

function WorkspacesPage() {
  const [createOpen, setCreateOpen] = useState(false);
  const { data: workspaces } = useSuspenseQuery(workspaceListQuery());
  const deleteMutation = useDeleteWorkspace();

  const handleDelete = (id: string, name: string) => {
    if (confirm(`Delete workspace "${name}"?`)) {
      deleteMutation.mutate(id);
    }
  };

  return (
    <div className="p-6 space-y-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold sm:text-3xl">Workspaces</h1>
          <p className="text-muted-foreground">
            Configure development environments
          </p>
        </div>
        <Button
          onClick={() => setCreateOpen(true)}
          className="w-full sm:w-auto"
        >
          <Plus className="h-4 w-4 mr-2" />
          New Workspace
        </Button>
      </div>

      {!workspaces || workspaces.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center justify-center py-12">
            <FolderGit2 className="h-12 w-12 text-muted-foreground mb-4" />
            <p className="text-muted-foreground mb-4">
              No workspaces configured
            </p>
            <Button onClick={() => setCreateOpen(true)}>
              <Plus className="h-4 w-4 mr-2" />
              Create your first workspace
            </Button>
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-4">
          {workspaces.map((workspace) => (
            <WorkspaceCard
              key={workspace.id}
              workspace={workspace}
              onDelete={() => handleDelete(workspace.id, workspace.name)}
            />
          ))}
        </div>
      )}

      <CreateWorkspaceDialog open={createOpen} onOpenChange={setCreateOpen} />
    </div>
  );
}

function WorkspaceCard({
  workspace,
  onDelete,
}: {
  workspace: Workspace;
  onDelete: () => void;
}) {
  const prebuildStatus = workspace.config.prebuild?.status ?? "none";
  const prebuildVariant = {
    none: "secondary",
    building: "warning",
    ready: "success",
    failed: "error",
  } as const;

  return (
    <Card>
      <CardHeader className="flex flex-col gap-3 pb-2 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex flex-wrap items-center gap-2">
          <Link to="/workspaces/$id" params={{ id: workspace.id }}>
            <CardTitle className="hover:underline cursor-pointer">
              {workspace.name}
            </CardTitle>
          </Link>
          <Badge variant={prebuildVariant[prebuildStatus]}>
            Prebuild: {prebuildStatus}
          </Badge>
        </div>
        <Button variant="ghost" size="icon" onClick={onDelete}>
          <Trash2 className="h-4 w-4 text-destructive" />
        </Button>
      </CardHeader>
      <CardContent>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
          <div>
            <span className="text-muted-foreground">Repositories</span>
            <p className="font-mono text-xs">
              {workspace.config.repos.length} repo(s)
            </p>
          </div>
          <div>
            <span className="text-muted-foreground">Base Image</span>
            <p>{workspace.config.baseImage}</p>
          </div>
          <div>
            <span className="text-muted-foreground">Resources</span>
            <p>
              {workspace.config.vcpus} vCPU / {workspace.config.memoryMb}MB
            </p>
          </div>
          <div>
            <span className="text-muted-foreground">Exposed Ports</span>
            <p>
              {workspace.config.exposedPorts.length > 0
                ? workspace.config.exposedPorts.join(", ")
                : "None"}
            </p>
          </div>
        </div>
        {workspace.config.initCommands.length > 0 && (
          <div className="mt-3">
            <span className="text-muted-foreground text-sm">Init Commands</span>
            <div className="bg-muted rounded p-2 mt-1 font-mono text-xs">
              {workspace.config.initCommands.map((cmd) => (
                <div key={cmd} className="truncate">
                  $ {cmd}
                </div>
              ))}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
