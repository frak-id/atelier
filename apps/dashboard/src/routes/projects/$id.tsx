import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import {
  ArrowLeft,
  Edit,
  FileCode,
  Play,
  Plus,
  RefreshCw,
  Rocket,
  Trash2,
} from "lucide-react";
import { useState } from "react";
import type { ConfigFile } from "@/api/client";
import {
  configFilesListQuery,
  projectDetailQuery,
  sandboxListQuery,
  useCreateConfigFile,
  useCreateSandbox,
  useDeleteConfigFile,
  useDeleteProject,
  useTriggerPrebuild,
  useUpdateConfigFile,
} from "@/api/queries";
import { EditProjectDialog } from "@/components/edit-project-dialog";
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
import { formatDate } from "@/lib/utils";

export const Route = createFileRoute("/projects/$id")({
  component: ProjectDetailPage,
  loader: ({ context, params }) => {
    context.queryClient.ensureQueryData(projectDetailQuery(params.id));
    context.queryClient.ensureQueryData(
      configFilesListQuery({ scope: "project", projectId: params.id }),
    );
  },
  pendingComponent: () => (
    <div className="p-6 space-y-6">
      <Skeleton className="h-8 w-64" />
      <Skeleton className="h-64" />
    </div>
  ),
});

function ProjectDetailPage() {
  const { id } = Route.useParams();
  const navigate = useNavigate();
  const { data: project } = useSuspenseQuery(projectDetailQuery(id));
  const { data: sandboxes } = useSuspenseQuery(
    sandboxListQuery({ projectId: id }),
  );
  const { data: configFiles } = useSuspenseQuery(
    configFilesListQuery({ scope: "project", projectId: id }),
  );
  const [editOpen, setEditOpen] = useState(false);
  const [configDialogOpen, setConfigDialogOpen] = useState(false);
  const [editingConfig, setEditingConfig] = useState<ConfigFile | null>(null);

  const deleteMutation = useDeleteProject();
  const prebuildMutation = useTriggerPrebuild();
  const createSandboxMutation = useCreateSandbox();
  const createConfigMutation = useCreateConfigFile();
  const updateConfigMutation = useUpdateConfigFile();
  const deleteConfigMutation = useDeleteConfigFile();

  const handleDelete = () => {
    if (confirm(`Delete project "${project.name}"?`)) {
      deleteMutation.mutate(id, {
        onSuccess: () => navigate({ to: "/projects" }),
      });
    }
  };

  const handlePrebuild = () => {
    prebuildMutation.mutate(id);
  };

  const handleSpawnSandbox = () => {
    createSandboxMutation.mutate(
      { projectId: id },
      {
        onSuccess: (result) => {
          if ("id" in result && result.status !== "queued") {
            navigate({ to: "/sandboxes/$id", params: { id: result.id } });
          }
        },
      },
    );
  };

  const prebuildVariant = {
    none: "secondary",
    building: "warning",
    ready: "success",
    failed: "error",
  } as const;

  const projectSandboxes = sandboxes.filter((s) => s.projectId === id);

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center gap-4">
        <Button variant="ghost" size="icon" asChild>
          <Link to="/projects">
            <ArrowLeft className="h-4 w-4" />
          </Link>
        </Button>
        <div className="flex-1">
          <div className="flex items-center gap-3">
            <h1 className="text-3xl font-bold">{project.name}</h1>
            <Badge variant={prebuildVariant[project.prebuildStatus]}>
              Prebuild: {project.prebuildStatus}
            </Badge>
          </div>
          <p className="text-muted-foreground font-mono text-sm">
            {project.gitUrl}
          </p>
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
          <Button
            variant="outline"
            onClick={handlePrebuild}
            disabled={
              prebuildMutation.isPending ||
              project.prebuildStatus === "building"
            }
          >
            {prebuildMutation.isPending ||
            project.prebuildStatus === "building" ? (
              <RefreshCw className="h-4 w-4 mr-2 animate-spin" />
            ) : (
              <Rocket className="h-4 w-4 mr-2" />
            )}
            {project.prebuildStatus === "building"
              ? "Building..."
              : "Trigger Prebuild"}
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
            <DetailRow label="ID" value={project.id} mono />
            <DetailRow
              label="Default Branch"
              value={project.defaultBranch}
              mono
            />
            <DetailRow label="Base Image" value={project.baseImage} />
            <DetailRow
              label="Resources"
              value={`${project.vcpus} vCPU / ${project.memoryMb}MB`}
            />
            <DetailRow label="Created" value={formatDate(project.createdAt)} />
            <DetailRow label="Updated" value={formatDate(project.updatedAt)} />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Prebuild Status</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="flex justify-between items-center">
              <span className="text-muted-foreground">Status</span>
              <Badge variant={prebuildVariant[project.prebuildStatus]}>
                {project.prebuildStatus}
              </Badge>
            </div>
            {project.latestPrebuildId && (
              <DetailRow
                label="Latest Prebuild"
                value={project.latestPrebuildId}
                mono
              />
            )}
            <DetailRow
              label="Exposed Ports"
              value={
                project.exposedPorts.length > 0
                  ? project.exposedPorts.join(", ")
                  : "None"
              }
            />
          </CardContent>
        </Card>

        {project.initCommands.length > 0 && (
          <Card>
            <CardHeader>
              <CardTitle>Init Commands</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="bg-muted rounded p-3 font-mono text-sm space-y-1">
                {project.initCommands.map((cmd) => (
                  <div key={cmd}>$ {cmd}</div>
                ))}
              </div>
            </CardContent>
          </Card>
        )}

        {project.startCommands.length > 0 && (
          <Card>
            <CardHeader>
              <CardTitle>Start Commands</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="bg-muted rounded p-3 font-mono text-sm space-y-1">
                {project.startCommands.map((cmd) => (
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
              Config Files ({configFiles.length})
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
            {configFiles.length === 0 ? (
              <p className="text-muted-foreground">
                No project-specific config files. Add one to override global
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
            <CardTitle>Active Sandboxes ({projectSandboxes.length})</CardTitle>
          </CardHeader>
          <CardContent>
            {projectSandboxes.length === 0 ? (
              <p className="text-muted-foreground">
                No sandboxes for this project
              </p>
            ) : (
              <div className="space-y-2">
                {projectSandboxes.map((sandbox) => (
                  <Link
                    key={sandbox.id}
                    to="/sandboxes/$id"
                    params={{ id: sandbox.id }}
                    className="flex items-center justify-between p-3 rounded-lg hover:bg-muted transition-colors"
                  >
                    <div className="flex items-center gap-3">
                      <span className="font-mono">{sandbox.id}</span>
                      <Badge
                        variant={
                          sandbox.status === "running"
                            ? "success"
                            : sandbox.status === "creating"
                              ? "warning"
                              : "secondary"
                        }
                      >
                        {sandbox.status}
                      </Badge>
                    </div>
                    <span className="text-muted-foreground text-sm">
                      {sandbox.ipAddress}
                    </span>
                  </Link>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      <EditProjectDialog
        project={project}
        open={editOpen}
        onOpenChange={setEditOpen}
      />

      <ConfigFileDialog
        projectId={id}
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
              { ...data, scope: "project", projectId: id },
              { onSuccess: () => setConfigDialogOpen(false) },
            );
          }
        }}
        isPending={
          createConfigMutation.isPending || updateConfigMutation.isPending
        }
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
  projectId: string;
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
              placeholder="/home/coder/.config/opencode/config.json"
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
