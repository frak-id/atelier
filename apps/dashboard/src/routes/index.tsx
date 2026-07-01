import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { AlertCircle, CheckCircle, ExternalLink, Server } from "lucide-react";
import { Component, type ReactNode, Suspense, useState } from "react";
import {
  allSandboxServicesQuery,
  organizationListQuery,
  sandboxListQuery,
  useDeleteSandbox,
  useRestartSandbox,
  useStartSandbox,
  useStopSandbox,
  workspaceListQuery,
} from "@/api/queries";
import { AttentionBlock } from "@/components/attention-block";
import { RouteErrorComponent } from "@/components/route-error";
import { SandboxCard } from "@/components/sandbox-card";
import { StartWorkingCard } from "@/components/start-working-card";
import { Badge } from "@/components/ui/badge";
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
import { useAttentionData } from "@/hooks/use-attention-data";
import { useDrawer } from "@/providers/drawer-provider";

class SectionErrorBoundary extends Component<
  { children: ReactNode; fallback?: ReactNode },
  { hasError: boolean }
> {
  constructor(props: { children: ReactNode; fallback?: ReactNode }) {
    super(props);
    this.state = { hasError: false };
  }
  static getDerivedStateFromError() {
    return { hasError: true };
  }
  render() {
    if (this.state.hasError) {
      return (
        this.props.fallback || (
          <div className="p-4 border border-destructive/50 rounded bg-destructive/10 text-destructive text-sm flex items-center gap-2">
            <AlertCircle className="h-4 w-4" />
            Failed to load section
          </div>
        )
      );
    }
    return this.props.children;
  }
}

export const Route = createFileRoute("/")({
  component: MissionControlPage,
  loader: ({ context }) => {
    context.queryClient.ensureQueryData(workspaceListQuery());
    context.queryClient.ensureQueryData(sandboxListQuery());
  },
  pendingComponent: MissionControlSkeleton,
  errorComponent: RouteErrorComponent,
});

function MissionControlPage() {
  const { openSandbox } = useDrawer();
  const [orgFilter, setOrgFilter] = useState<string>("all");
  const { data: organizations } = useQuery(organizationListQuery());

  return (
    <div className="p-6 space-y-8 max-w-7xl mx-auto">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="space-y-2">
          <h1 className="text-3xl font-bold tracking-tight">Mission Control</h1>
          <p className="text-muted-foreground">
            Overview of all active operations across your sandboxes.
          </p>
        </div>
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
      </div>

      <div className="space-y-8">
        <SectionErrorBoundary>
          <Suspense fallback={<Skeleton className="h-48 w-full" />}>
            <AttentionSection />
          </Suspense>
        </SectionErrorBoundary>

        <SectionErrorBoundary>
          <Suspense fallback={<Skeleton className="h-64 w-full" />}>
            <StartWorkingCard />
          </Suspense>
        </SectionErrorBoundary>

        <SectionErrorBoundary>
          <Suspense fallback={<Skeleton className="h-64 w-full" />}>
            <RunningSandboxesSection
              onSelectSandbox={openSandbox}
              orgFilter={orgFilter}
            />
          </Suspense>
        </SectionErrorBoundary>

        <SectionErrorBoundary>
          <Suspense fallback={<Skeleton className="h-32 w-full" />}>
            <DevCommandsSection />
          </Suspense>
        </SectionErrorBoundary>
      </div>
    </div>
  );
}

function AttentionSection() {
  const { groups, isLoading, count } = useAttentionData();
  const { openSandbox } = useDrawer();

  if (isLoading) {
    return <Skeleton className="h-32 w-full" />;
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <h2 className="text-xl font-semibold flex items-center gap-2">
          Needs Attention
          {count > 0 && <Badge variant="destructive">{count}</Badge>}
        </h2>
      </div>

      {groups.length === 0 ? (
        <Card className="bg-muted/5 border-dashed">
          <CardContent className="flex items-center gap-4 py-6">
            <div className="h-10 w-10 rounded-full bg-green-500/10 flex items-center justify-center shrink-0">
              <CheckCircle className="h-6 w-6 text-green-500" />
            </div>
            <div>
              <p className="font-medium">All clear</p>
              <p className="text-sm text-muted-foreground">
                No pending permissions or questions across running sessions.
              </p>
            </div>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-3">
          {groups.map((group) => (
            <AttentionBlock
              key={group.sandboxId}
              permissions={group.permissions}
              questions={group.questions}
              sandboxId={group.sandboxId}
              workspaceName={group.workspaceName}
              onOpenSandbox={openSandbox}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function RunningSandboxesSection({
  onSelectSandbox,
  orgFilter,
}: {
  onSelectSandbox: (id: string) => void;
  orgFilter: string;
}) {
  const { data: sandboxes } = useQuery(sandboxListQuery());
  const runningSandboxes = (sandboxes ?? []).filter(
    (s) =>
      s.status === "running" &&
      (orgFilter === "all" || !s.orgId || s.orgId === orgFilter),
  );
  const workspaceDataMap = useQuery({
    ...workspaceListQuery(),
    select: (workspaces) => {
      const map = new Map();
      for (const w of workspaces ?? []) map.set(w.id, w);
      return map;
    },
  }).data;

  const deleteSandbox = useDeleteSandbox();
  const stopSandbox = useStopSandbox();
  const startSandbox = useStartSandbox();
  const restartSandbox = useRestartSandbox();

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <h2 className="text-xl font-semibold flex items-center gap-2">
          Running Sandboxes
          {runningSandboxes.length > 0 && (
            <Badge variant="outline">{runningSandboxes.length}</Badge>
          )}
        </h2>
      </div>

      {runningSandboxes.length === 0 ? (
        <Card className="bg-muted/5 border-dashed">
          <CardContent className="flex flex-col items-center justify-center py-8 text-center">
            <Server className="h-10 w-10 text-muted-foreground/50 mb-3" />
            <p className="font-medium text-muted-foreground">
              No sandboxes running
            </p>
            <p className="text-sm text-muted-foreground/70 mt-1">
              Start a session above to spin up a sandbox
            </p>
          </CardContent>
        </Card>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          {runningSandboxes.map((sandbox) => (
            <SandboxCard
              key={sandbox.id}
              sandbox={sandbox}
              workspace={
                sandbox.workspaceId
                  ? workspaceDataMap?.get(sandbox.workspaceId)
                  : undefined
              }
              onShowDetails={() => onSelectSandbox(sandbox.id)}
              onDelete={() => deleteSandbox.mutate(sandbox.id)}
              onStop={() => stopSandbox.mutate(sandbox.id)}
              onStart={() => startSandbox.mutate(sandbox.id)}
              onRecreate={() => restartSandbox.mutate(sandbox.id)}
              isStopping={stopSandbox.isPending}
              isStarting={startSandbox.isPending}
              isRecreating={restartSandbox.isPending}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function DevCommandsSection() {
  const { data: sandboxes } = useQuery(sandboxListQuery());
  const { data: allServices } = useQuery(allSandboxServicesQuery);
  const runningSandboxes =
    sandboxes?.filter((s) => s.status === "running") ?? [];

  const activeServers = runningSandboxes.filter((sandbox) =>
    allServices?.[sandbox.id]?.some((svc) => svc.name === "dev" && svc.running),
  );

  if (activeServers.length === 0) {
    return null;
  }

  return (
    <div className="space-y-4">
      <h2 className="text-xl font-semibold flex items-center gap-2">
        Dev Servers
        <Badge variant="secondary" className="bg-green-500/10 text-green-600">
          {activeServers.length} Active
        </Badge>
      </h2>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {activeServers.map((sandbox) => (
          <Card key={sandbox.id} className="bg-muted/30">
            <CardContent className="p-4 flex items-center justify-between">
              <div className="space-y-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="font-medium truncate">
                    {sandbox.name ?? sandbox.id}
                  </span>
                  <Badge variant="outline" className="text-xs h-5 px-1.5">
                    {sandbox.id}
                  </Badge>
                </div>
                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                  <span className="h-1.5 w-1.5 rounded-full bg-green-500 animate-pulse" />
                  Running
                </div>
              </div>
              {sandbox.runtime.urls.dev && (
                <Button variant="ghost" size="icon" asChild>
                  <a
                    href={sandbox.runtime.urls.dev}
                    target="_blank"
                    rel="noopener noreferrer"
                    title="Open Dev Server"
                  >
                    <ExternalLink className="h-4 w-4" />
                  </a>
                </Button>
              )}
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}

function MissionControlSkeleton() {
  return (
    <div className="p-6 space-y-8 max-w-7xl mx-auto">
      <div className="space-y-2">
        <Skeleton className="h-9 w-64" />
        <Skeleton className="h-5 w-96" />
      </div>

      <div className="space-y-8">
        <Skeleton className="h-32 w-full" />
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <Skeleton className="h-48" />
          <Skeleton className="h-48" />
          <Skeleton className="h-48" />
        </div>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
          <Skeleton className="h-64" />
          <Skeleton className="h-64" />
          <Skeleton className="h-64" />
        </div>
      </div>
    </div>
  );
}
