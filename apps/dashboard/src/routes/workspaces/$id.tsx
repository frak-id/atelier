import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import {
  AlertTriangle,
  ArrowLeft,
  Clock,
  Edit,
  FileCode,
  Play,
  Plus,
  RefreshCw,
  Trash2,
} from "lucide-react";
import { useState } from "react";
import type { ConfigFile } from "@/api/client";
import {
  configFilesListQuery,
  sandboxListQuery,
  useCreateConfigFile,
  useCreateSandbox,
  useDeleteConfigFile,
  useDeletePrebuild,
  useDeleteWorkspace,
  useTriggerPrebuild,
  useUpdateConfigFile,
  workspaceDetailQuery,
} from "@/api/queries";
import { EditWorkspaceDialog } from "@/components/edit-workspace-dialog";
import { SandboxDrawer } from "@/components/sandbox-drawer";
import { SandboxRow } from "@/components/sandbox-row";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { WorkspaceSessionTemplatesSection } from "@/components/workspace-session-templates";
import { formatDate } from "@/lib/utils";

export const Route = createFileRoute("/workspaces/$id")({
  component: WorkspaceDetailPage,
  loader: ({ context, params }) => {
    context.queryClient.ensureQueryData(workspaceDetailQuery(params.id));
    context.queryClient.ensureQueryData(
      configFilesListQuery({ scope: "workspace", workspaceId: params.id }),
    );
  },
  pendingComponent: () => (
    <div className="p-6 space-y-6">
      <Skeleton className="h-8 w-64" />
      <Skeleton className="h-64" />
    </div>
  ),
});

function WorkspaceDetailPage() {
  const { id } = Route.useParams();
  const navigate = useNavigate();
  const { data: workspace } = useSuspenseQuery(workspaceDetailQuery(id));
  const { data: sandboxes } = useSuspenseQuery(
    sandboxListQuery({ workspaceId: id }),
  );
  const { data: configFiles } = useSuspenseQuery(
    configFilesListQuery({ scope: "workspace", workspaceId: id }),
  );
  const [editOpen, setEditOpen] = useState(false);
  const [configDialogOpen, setConfigDialogOpen] = useState(false);
  const [editingConfig, setEditingConfig] = useState<ConfigFile | null>(null);
  const [selectedSandboxId, setSelectedSandboxId] = useState<string | null>(
    null,
  );

  const deleteMutation = useDeleteWorkspace();
  const createSandboxMutation = useCreateSandbox();
  const prebuildMutation = useTriggerPrebuild();
  const deletePrebuildMutation = useDeletePrebuild();
  const createConfigMutation = useCreateConfigFile();
  const updateConfigMutation = useUpdateConfigFile();
  const deleteConfigMutation = useDeleteConfigFile();

  if (!workspace) {
    return <div>Workspace not found</div>;
  }

  const handleDelete = () => {
    if (confirm(`Delete workspace "${workspace.name}"?`)) {
      deleteMutation.mutate(id, {
        onSuccess: () => navigate({ to: "/workspaces" }),
      });
    }
  };

  const handleSpawnSandbox = () => {
    createSandboxMutation.mutate(
      { workspaceId: id },
      {
        onSuccess: (result) => {
          if (result && "id" in result) {
            setSelectedSandboxId(result.id);
          }
        },
      },
    );
  };

  const prebuildStatus = workspace.config.prebuild?.status ?? "none";
  const prebuildVariant = {
    none: "secondary",
    building: "warning",
    ready: "success",
    failed: "error",
  } as const;

  const workspaceSandboxes =
    sandboxes?.filter((s) => s.workspaceId === id) ?? [];

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center gap-4">
        <Button variant="ghost" size="icon" asChild>
          <Link to="/workspaces">
            <ArrowLeft className="h-4 w-4" />
          </Link>
        </Button>
        <div className="flex-1">
          <div className="flex items-center gap-3">
            <h1 className="text-3xl font-bold">{workspace.name}</h1>
            <Badge variant={prebuildVariant[prebuildStatus]}>
              Prebuild: {prebuildStatus}
            </Badge>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => prebuildMutation.mutate(id)}
              disabled={
                prebuildMutation.isPending ||
                deletePrebuildMutation.isPending ||
                prebuildStatus === "building"
              }
              title="Rebuild prebuild (deletes existing and creates fresh from base image)"
            >
              <RefreshCw
                className={`h-4 w-4 ${prebuildMutation.isPending || prebuildStatus === "building" ? "animate-spin" : ""}`}
              />
            </Button>
            {prebuildStatus === "ready" && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  if (confirm("Delete the prebuild snapshot?")) {
                    deletePrebuildMutation.mutate(id);
                  }
                }}
                disabled={
                  deletePrebuildMutation.isPending || prebuildMutation.isPending
                }
                title="Delete prebuild"
              >
                <Trash2
                  className={`h-4 w-4 text-destructive ${deletePrebuildMutation.isPending ? "animate-pulse" : ""}`}
                />
              </Button>
            )}
          </div>
          <div className="flex items-center gap-4 text-sm text-muted-foreground">
            <span>
              {workspace.config.repos.length} repository(ies) configured
            </span>
            {prebuildStatus === "ready" && (
              <>
                {workspace.config.prebuild?.stale && (
                  <span className="flex items-center gap-1 text-yellow-400">
                    <AlertTriangle className="h-3 w-3" />
                    Stale
                  </span>
                )}
                {workspace.config.prebuild?.builtAt && (
                  <span className="flex items-center gap-1">
                    <Clock className="h-3 w-3" />
                    Built: {formatDate(workspace.config.prebuild.builtAt)}
                  </span>
                )}
                {workspace.config.prebuild?.lastCheckedAt && (
                  <span className="flex items-center gap-1">
                    Checked:{" "}
                    {formatDate(workspace.config.prebuild.lastCheckedAt)}
                  </span>
                )}
              </>
            )}
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            onClick={handleSpawnSandbox}
            disabled={createSandboxMutation.isPending}
          >
            {createSandboxMutation.isPending ? (
              <RefreshCw className="h-4 w-4 mr-2 animate-spin" />
            ) : (
              <Play className="h-4 w-4 mr-2" />
            )}
            Spawn Sandbox
          </Button>
          <Button variant="outline" onClick={() => setEditOpen(true)}>
            <Edit className="h-4 w-4 mr-2" />
            Edit
          </Button>
          <Button variant="destructive" onClick={handleDelete}>
            <Trash2 className="h-4 w-4 mr-2" />
            Delete
          </Button>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <Card>
          <CardHeader>
            <CardTitle>Configuration</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <DetailRow label="ID" value={workspace.id} mono />
            <DetailRow label="Base Image" value={workspace.config.baseImage} />
            <DetailRow
              label="Resources"
              value={`${workspace.config.vcpus} vCPU / ${workspace.config.memoryMb}MB`}
            />
            <DetailRow
              label="Exposed Ports"
              value={
                workspace.config.exposedPorts.length > 0
                  ? workspace.config.exposedPorts.join(", ")
                  : "None"
              }
            />
            <DetailRow
              label="Created"
              value={formatDate(workspace.createdAt)}
            />
            <DetailRow
              label="Updated"
              value={formatDate(workspace.updatedAt)}
            />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>
              Repositories ({workspace.config.repos.length})
            </CardTitle>
          </CardHeader>
          <CardContent>
            {workspace.config.repos.length === 0 ? (
              <p className="text-muted-foreground">
                No repositories configured
              </p>
            ) : (
              <div className="space-y-2">
                {workspace.config.repos.map((repo) => (
                  <div
                    key={
                      "url" in repo ? repo.url : `${repo.sourceId}:${repo.repo}`
                    }
                    className="p-2 bg-muted rounded text-sm font-mono"
                  >
                    {"url" in repo
                      ? repo.url
                      : `${repo.repo} (source: ${repo.sourceId})`}
                    <span className="text-muted-foreground ml-2">
                      → {repo.clonePath}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        {workspace.config.initCommands.length > 0 && (
          <Card>
            <CardHeader>
              <CardTitle>Init Commands</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="bg-muted rounded p-3 font-mono text-sm space-y-1">
                {workspace.config.initCommands.map((cmd) => (
                  <div key={cmd}>$ {cmd}</div>
                ))}
              </div>
            </CardContent>
          </Card>
        )}

        <Card className="lg:col-span-2">
          <CardHeader className="flex flex-row items-center justify-between">
            <CardTitle className="flex items-center gap-2">
              <FileCode className="h-5 w-5" />
              Config Files ({configFiles?.length ?? 0})
            </CardTitle>
            <Button
              size="sm"
              onClick={() => {
                setEditingConfig(null);
                setConfigDialogOpen(true);
              }}
            >
              <Plus className="h-4 w-4 mr-1" />
              Add
            </Button>
          </CardHeader>
          <CardContent>
            {!configFiles || configFiles.length === 0 ? (
              <p className="text-muted-foreground">
                No workspace-specific config files. Add one to override global
                configs.
              </p>
            ) : (
              <div className="space-y-2">
                {configFiles.map((config) => (
                  <div
                    key={config.id}
                    className="flex items-center justify-between p-3 rounded-lg bg-muted/50 hover:bg-muted transition-colors"
                  >
                    <div className="flex items-center gap-3">
                      <span className="font-mono text-sm">{config.path}</span>
                      <Badge variant="secondary">{config.contentType}</Badge>
                    </div>
                    <div className="flex items-center gap-2">
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => {
                          setEditingConfig(config);
                          setConfigDialogOpen(true);
                        }}
                      >
                        <Edit className="h-4 w-4" />
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => {
                          if (confirm(`Delete config file "${config.path}"?`)) {
                            deleteConfigMutation.mutate(config.id);
                          }
                        }}
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle>
              Active Sandboxes ({workspaceSandboxes.length})
            </CardTitle>
          </CardHeader>
          <CardContent>
            {workspaceSandboxes.length === 0 ? (
              <p className="text-muted-foreground">
                No sandboxes for this workspace
              </p>
            ) : (
              <div className="space-y-2">
                {workspaceSandboxes.map((sandbox) => (
                  <SandboxRow
                    key={sandbox.id}
                    sandbox={sandbox}
                    workspaceName={workspace.name}
                    onSandboxClick={setSelectedSandboxId}
                  />
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        <div className="lg:col-span-2">
          <WorkspaceSessionTemplatesSection workspaceId={id} />
        </div>
      </div>

      <EditWorkspaceDialog
        workspace={workspace}
        open={editOpen}
        onOpenChange={setEditOpen}
      />

      <ConfigFileDialog
        workspaceId={id}
        config={editingConfig}
        open={configDialogOpen}
        onOpenChange={(open) => {
          setConfigDialogOpen(open);
          if (!open) setEditingConfig(null);
        }}
        onSubmit={(data) => {
          if (editingConfig) {
            updateConfigMutation.mutate(
              { id: editingConfig.id, data },
              { onSuccess: () => setConfigDialogOpen(false) },
            );
          } else {
            createConfigMutation.mutate(
              { ...data, scope: "workspace", workspaceId: id },
              { onSuccess: () => setConfigDialogOpen(false) },
            );
          }
        }}
        isPending={
          createConfigMutation.isPending || updateConfigMutation.isPending
        }
      />

      <SandboxDrawer
        sandboxId={selectedSandboxId}
        onClose={() => setSelectedSandboxId(null)}
      />
    </div>
  );
}

function DetailRow({
  label,
  value,
  mono,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <div className="flex justify-between">
      <span className="text-muted-foreground">{label}</span>
      <span className={mono ? "font-mono" : ""}>{value}</span>
    </div>
  );
}

type ConfigDialogProps = {
  workspaceId: string;
  config: ConfigFile | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSubmit: (data: {
    path: string;
    content: string;
    contentType: "json" | "text" | "binary";
  }) => void;
  isPending: boolean;
};

function ConfigFileDialog({
  config,
  open,
  onOpenChange,
  onSubmit,
  isPending,
}: ConfigDialogProps) {
  const [path, setPath] = useState(config?.path ?? "");
  const [content, setContent] = useState(config?.content ?? "");
  const [contentType, setContentType] = useState<"json" | "text" | "binary">(
    config?.contentType ?? "json",
  );

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    onSubmit({ path, content, contentType });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>
            {config ? "Edit Config File" : "Add Config File"}
          </DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="path">Path</Label>
            <Input
              id="path"
              value={path}
              onChange={(e) => setPath(e.target.value)}
              placeholder="~/.config/opencode/opencode.json"
              disabled={!!config}
              required
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="contentType">Content Type</Label>
            <Select
              value={contentType}
              onValueChange={(v) =>
                setContentType(v as "json" | "text" | "binary")
              }
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="json">JSON</SelectItem>
                <SelectItem value="text">Text</SelectItem>
                <SelectItem value="binary">Binary (base64)</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-2">
            <Label htmlFor="content">Content</Label>
            <Textarea
              id="content"
              value={content}
              onChange={(e) => setContent(e.target.value)}
              placeholder={
                contentType === "json"
                  ? '{\n  "key": "value"\n}'
                  : "File content..."
              }
              className="font-mono text-sm min-h-[200px]"
              required
            />
          </div>

          <div className="flex justify-end gap-2">
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={isPending}>
              {isPending ? (
                <RefreshCw className="h-4 w-4 mr-2 animate-spin" />
              ) : null}
              {config ? "Update" : "Create"}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
