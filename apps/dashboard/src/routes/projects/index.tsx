import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { FolderGit2, Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import type { Project } from "@/api/client";
import { projectListQuery, useDeleteProject } from "@/api/queries";
import { CreateProjectDialog } from "@/components/create-project-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";

export const Route = createFileRoute("/projects/")({
  component: ProjectsPage,
  loader: ({ context }) => {
    context.queryClient.ensureQueryData(projectListQuery());
  },
  pendingComponent: () => (
    <div className="p-6 space-y-6">
      <Skeleton className="h-9 w-48" />
      <div className="grid gap-4">
        {[...Array(3)].map((_, i) => (
          <Skeleton key={i} className="h-40" />
        ))}
      </div>
    </div>
  ),
});

function ProjectsPage() {
  const [createOpen, setCreateOpen] = useState(false);
  const { data: projects } = useSuspenseQuery(projectListQuery());
  const deleteMutation = useDeleteProject();

  const handleDelete = (id: string, name: string) => {
    if (confirm(`Delete project "${name}"?`)) {
      deleteMutation.mutate(id);
    }
  };

  return (
    <div className="p-6 space-y-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold sm:text-3xl">Projects</h1>
          <p className="text-muted-foreground">
            Configure repositories and prebuilds
          </p>
        </div>
        <Button
          onClick={() => setCreateOpen(true)}
          className="w-full sm:w-auto"
        >
          <Plus className="h-4 w-4 mr-2" />
          New Project
        </Button>
      </div>

      {projects.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center justify-center py-12">
            <FolderGit2 className="h-12 w-12 text-muted-foreground mb-4" />
            <p className="text-muted-foreground mb-4">No projects configured</p>
            <Button onClick={() => setCreateOpen(true)}>
              <Plus className="h-4 w-4 mr-2" />
              Create your first project
            </Button>
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-4">
          {projects.map((project) => (
            <ProjectCard
              key={project.id}
              project={project}
              onDelete={() => handleDelete(project.id, project.name)}
            />
          ))}
        </div>
      )}

      <CreateProjectDialog open={createOpen} onOpenChange={setCreateOpen} />
    </div>
  );
}

function ProjectCard({
  project,
  onDelete,
}: {
  project: Project;
  onDelete: () => void;
}) {
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
          <Link to="/projects/$id" params={{ id: project.id }}>
            <CardTitle className="hover:underline cursor-pointer">
              {project.name}
            </CardTitle>
          </Link>
          <Badge variant={prebuildVariant[project.prebuildStatus]}>
            Prebuild: {project.prebuildStatus}
          </Badge>
        </div>
        <Button variant="ghost" size="icon" onClick={onDelete}>
          <Trash2 className="h-4 w-4 text-destructive" />
        </Button>
      </CardHeader>
      <CardContent>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
          <div>
            <span className="text-muted-foreground">Repository</span>
            <p className="font-mono text-xs truncate" title={project.gitUrl}>
              {project.gitUrl}
            </p>
          </div>
          <div>
            <span className="text-muted-foreground">Branch</span>
            <p className="font-mono">{project.defaultBranch}</p>
          </div>
          <div>
            <span className="text-muted-foreground">Base Image</span>
            <p>{project.baseImage}</p>
          </div>
          <div>
            <span className="text-muted-foreground">Resources</span>
            <p>
              {project.vcpus} vCPU / {project.memoryMb}MB
            </p>
          </div>
        </div>
        {project.initCommands.length > 0 && (
          <div className="mt-3">
            <span className="text-muted-foreground text-sm">Init Commands</span>
            <div className="bg-muted rounded p-2 mt-1 font-mono text-xs">
              {project.initCommands.map((cmd, i) => (
                <div key={i} className="truncate">
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
