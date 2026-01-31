import { useQuery, useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { Plus } from "lucide-react";
import { useState } from "react";
import type { Sandbox } from "@/api/client";
import {
  sandboxListQuery,
  sshKeysListQuery,
  taskListQuery,
  useCreateSandbox,
  useDeleteSandbox,
  useStartSandbox,
  useStopSandbox,
  useWorkspaceDataMap,
} from "@/api/queries";
import { CreateSandboxDialog } from "@/components/create-sandbox-dialog";
import { SandboxCard } from "@/components/sandbox-card";
import { SshKeyAlert } from "@/components/ssh-key-alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { useDrawer } from "@/providers/drawer-provider";

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
          // biome-ignore lint/suspicious/noArrayIndexKey: Static skeleton placeholders never reorder
          <Skeleton key={i} className="h-32" />
        ))}
      </div>
    </div>
  ),
});

function SandboxesPage() {
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [createOpen, setCreateOpen] = useState(false);
  const { openSandbox, openTask } = useDrawer();
  const [recreatingId, setRecreatingId] = useState<string | null>(null);
  const { data: sandboxes } = useSuspenseQuery(sandboxListQuery());
  const { data: sshKeys } = useQuery(sshKeysListQuery);
  const { data: tasks } = useQuery(taskListQuery());
  const workspaceDataMap = useWorkspaceDataMap();
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

      <SshKeyAlert keys={sshKeys} />

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
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
          {filteredSandboxes.map((sandbox) => {
            const workspace = sandbox.workspaceId
              ? workspaceDataMap.get(sandbox.workspaceId)
              : undefined;
            const task = tasks?.find((t) => t.data.sandboxId === sandbox.id);
            return (
              <SandboxCard
                key={sandbox.id}
                sandbox={sandbox}
                workspace={workspace}
                task={task}
                onDelete={() => handleDelete(sandbox.id)}
                onRecreate={() => handleRecreate(sandbox)}
                isRecreating={recreatingId === sandbox.id}
                onStop={() => stopMutation.mutate(sandbox.id)}
                onStart={() => startMutation.mutate(sandbox.id)}
                isStopping={
                  stopMutation.isPending &&
                  stopMutation.variables === sandbox.id
                }
                isStarting={
                  startMutation.isPending &&
                  startMutation.variables === sandbox.id
                }
                onShowDetails={() => openSandbox(sandbox.id)}
                onShowTask={() => {
                  if (task) openTask(task.id);
                }}
              />
            );
          })}
        </div>
      )}

      <CreateSandboxDialog open={createOpen} onOpenChange={setCreateOpen} />
    </div>
  );
}
