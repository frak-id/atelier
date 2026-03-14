import { useQuery, useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { FolderGit2, Plus } from "lucide-react";
import { useState } from "react";
import type { Workspace } from "@/api/client";
import {
  organizationListQuery,
  useOrganizationMap,
  workspaceListQuery,
} from "@/api/queries";
import { CreateWorkspaceDialog } from "@/components/create-workspace-dialog";
import { RouteErrorComponent } from "@/components/route-error";
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
import { cn } from "@/lib/utils";

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
          // biome-ignore lint/suspicious/noArrayIndexKey: Static skeleton placeholders never reorder
          <Skeleton key={i} className="h-40" />
        ))}
      </div>
    </div>
  ),
  errorComponent: RouteErrorComponent,
});

function WorkspacesPage() {
  const [createOpen, setCreateOpen] = useState(false);
  const [orgFilter, setOrgFilter] = useState<string>("all");
  const { data: workspaces } = useSuspenseQuery(workspaceListQuery());
  const { data: organizations } = useQuery(organizationListQuery());
  const orgMap = useOrganizationMap();

  const filtered =
    orgFilter === "all"
      ? workspaces
      : workspaces?.filter((w) => !w.orgId || w.orgId === orgFilter);

  return (
    <div className="p-6 space-y-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold sm:text-3xl">Workspaces</h1>
          <p className="text-muted-foreground">
            Configure development environments
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Select value={orgFilter} onValueChange={setOrgFilter}>
            <SelectTrigger className="w-full sm:w-[180px]">
              <SelectValue placeholder="All Organizations" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Organizations</SelectItem>
              {(organizations ?? []).map((org) => (
                <SelectItem key={org.id} value={org.id}>
                  {org.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button
            onClick={() => setCreateOpen(true)}
            className="w-full sm:w-auto"
          >
            <Plus className="h-4 w-4 mr-2" />
            New Workspace
          </Button>
        </div>
      </div>

      {!filtered || filtered.length === 0 ? (
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
          {filtered.map((workspace) => (
            <WorkspaceCard
              key={workspace.id}
              workspace={workspace}
              orgName={
                organizations && organizations.length > 1
                  ? orgMap.get(workspace.orgId ?? "")
                  : undefined
              }
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
  orgName,
}: {
  workspace: Workspace;
  orgName?: string;
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
      <CardHeader className="pb-2">
        <div className="flex flex-wrap items-center gap-2">
          <Link to="/workspaces/$id" params={{ id: workspace.id }}>
            <CardTitle className="hover:underline cursor-pointer">
              {workspace.name}
            </CardTitle>
          </Link>
          <Badge variant={prebuildVariant[prebuildStatus]}>
            Prebuild: {prebuildStatus}
          </Badge>
          {orgName && <Badge variant="outline">{orgName}</Badge>}
        </div>
        {workspace.config.description && (
          <ExpandableDescription text={workspace.config.description} />
        )}
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

function ExpandableDescription({ text }: { text: string }) {
  const [expanded, setExpanded] = useState(false);
  const isLong = text.length > 150;

  return (
    <div>
      <p
        className={cn(
          "text-sm leading-relaxed text-muted-foreground",
          !expanded && "line-clamp-2",
        )}
      >
        {text}
      </p>
      {isLong && (
        <button
          type="button"
          className="text-xs text-muted-foreground/70 hover:text-muted-foreground mt-0.5 transition-colors"
          onClick={() => setExpanded(!expanded)}
        >
          {expanded ? "Show less" : "Show more"}
        </button>
      )}
    </div>
  );
}
