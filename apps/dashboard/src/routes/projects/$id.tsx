import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { ArrowLeft, Edit, Play, RefreshCw, Rocket, Trash2 } from "lucide-react";
import { useState } from "react";
import {
  projectDetailQuery,
  sandboxListQuery,
  useCreateSandbox,
  useDeleteProject,
  useTriggerPrebuild,
} from "@/api/queries";
import { EditProjectDialog } from "@/components/edit-project-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { formatDate } from "@/lib/utils";

export const Route = createFileRoute("/projects/$id")({
  component: ProjectDetailPage,
  loader: ({ context, params }) => {
    context.queryClient.ensureQueryData(projectDetailQuery(params.id));
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
  const [editOpen, setEditOpen] = useState(false);

  const deleteMutation = useDeleteProject();
  const prebuildMutation = useTriggerPrebuild();
  const createSandboxMutation = useCreateSandbox();

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
                {project.initCommands.map((cmd, i) => (
                  <div key={i}>$ {cmd}</div>
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
                {project.startCommands.map((cmd, i) => (
                  <div key={i}>$ {cmd}</div>
                ))}
              </div>
            </CardContent>
          </Card>
        )}

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
