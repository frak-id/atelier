import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { Activity, Container, Cpu, HardDrive, Play, Zap } from "lucide-react";
import { platformOverviewQuery } from "@/api/queries/platform";
import { RouteErrorComponent } from "@/components/route-error";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";

export const Route = createFileRoute("/platform/")({
  component: PlatformPage,
  loader: ({ context }) => {
    context.queryClient.ensureQueryData(platformOverviewQuery);
  },
  pendingComponent: () => (
    <div className="p-6 space-y-6 max-w-7xl mx-auto">
      <Skeleton className="h-9 w-48" />
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {[...Array(2)].map((_, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: Static skeleton placeholders never reorder
          <Skeleton key={i} className="h-64" />
        ))}
      </div>
    </div>
  ),
  errorComponent: RouteErrorComponent,
});

function PlatformPage() {
  const { data: overview } = useQuery(platformOverviewQuery);

  if (!overview) {
    return (
      <div className="p-6 max-w-7xl mx-auto">
        <p className="text-muted-foreground">Loading platform data...</p>
      </div>
    );
  }

  return (
    <div className="p-6 space-y-6 max-w-7xl mx-auto">
      <div>
        <h1 className="text-2xl font-bold sm:text-3xl">Platform</h1>
        <p className="text-muted-foreground">
          BuildKit builders & GitHub Actions runners
        </p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <Card>
          <CardHeader>
            <div className="flex items-center justify-between">
              <div>
                <CardTitle className="flex items-center gap-2">
                  <Container className="h-5 w-5" />
                  BuildKit
                </CardTitle>
                <p className="text-sm text-muted-foreground mt-1">
                  Remote Docker builder daemon
                </p>
              </div>
              <Badge
                variant={overview.buildkit.enabled ? "success" : "secondary"}
              >
                {overview.buildkit.enabled ? "Enabled" : "Disabled"}
              </Badge>
            </div>
          </CardHeader>
          <CardContent>
            {overview.buildkit.enabled ? (
              <div className="space-y-4">
                <div className="text-sm font-medium">
                  Pods ({overview.buildkit.pods.length})
                </div>
                <div className="space-y-3">
                  {overview.buildkit.pods.map((pod) => (
                    <div
                      key={pod.name}
                      className="flex items-center justify-between p-3 border rounded-md bg-muted/30"
                    >
                      <div className="flex items-center gap-3">
                        <div className="font-mono text-sm">{pod.name}</div>
                        <Badge
                          variant={
                            pod.status === "Running"
                              ? "success"
                              : pod.status === "Pending"
                                ? "warning"
                                : pod.status === "Failed" ||
                                    pod.status === "Error"
                                  ? "destructive"
                                  : "secondary"
                          }
                          className="text-[10px] px-1.5 py-0 h-5"
                        >
                          {pod.ready ? "Ready" : pod.status}
                        </Badge>
                      </div>
                      <div className="flex items-center gap-4 text-xs text-muted-foreground font-mono">
                        <div className="flex items-center gap-1" title="CPU">
                          <Cpu className="h-3 w-3" />
                          {pod.cpu ?? "—"}
                        </div>
                        <div className="flex items-center gap-1" title="Memory">
                          <Activity className="h-3 w-3" />
                          {pod.memory ?? "—"}
                        </div>
                        <div
                          className="flex items-center gap-1"
                          title="Restarts"
                        >
                          <Zap className="h-3 w-3" />
                          {pod.restarts}
                        </div>
                      </div>
                    </div>
                  ))}
                  {overview.buildkit.pods.length === 0 && (
                    <div className="text-sm text-muted-foreground italic">
                      No BuildKit pods running
                    </div>
                  )}
                </div>

                {overview.buildkit.pvcs.length > 0 && (
                  <>
                    <div className="text-sm font-medium mt-6 mb-2">
                      Storage Cache
                    </div>
                    <div className="space-y-2">
                      {overview.buildkit.pvcs.map((pvc) => (
                        <div
                          key={pvc.name}
                          className="flex items-center justify-between text-sm"
                        >
                          <div className="flex items-center gap-2">
                            <HardDrive className="h-4 w-4 text-muted-foreground" />
                            <span className="font-mono text-xs">
                              {pvc.name}
                            </span>
                          </div>
                          <div className="flex items-center gap-3">
                            <span className="text-xs text-muted-foreground font-mono">
                              {pvc.capacity}
                            </span>
                            <Badge
                              variant={
                                pvc.phase === "Bound" ? "success" : "warning"
                              }
                              className="text-[10px] px-1.5 py-0 h-5"
                            >
                              {pvc.phase}
                            </Badge>
                          </div>
                        </div>
                      ))}
                    </div>
                  </>
                )}
              </div>
            ) : (
              <p className="text-sm text-muted-foreground italic">
                BuildKit is not enabled. Enable it in your Helm values to use
                remote Docker builds.
              </p>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <div className="flex items-center justify-between">
              <div>
                <CardTitle className="flex items-center gap-2">
                  <Play className="h-5 w-5" />
                  CI Runners
                </CardTitle>
                <p className="text-sm text-muted-foreground mt-1">
                  GitHub Actions Runner Controller
                </p>
              </div>
              <Badge
                variant={overview.runners.enabled ? "success" : "secondary"}
              >
                {overview.runners.enabled ? "Enabled" : "Disabled"}
              </Badge>
            </div>
          </CardHeader>
          <CardContent>
            {overview.runners.enabled ? (
              <div className="space-y-6">
                <div className="grid grid-cols-3 gap-4">
                  <div className="p-3 border rounded-md bg-muted/30 text-center">
                    <div className="text-xs text-muted-foreground mb-1">
                      Total Runners
                    </div>
                    <div className="text-2xl font-bold">
                      {overview.runners.totalRunners}
                    </div>
                  </div>
                  <div className="p-3 border rounded-md bg-muted/30 text-center">
                    <div className="text-xs text-muted-foreground mb-1">
                      Active Jobs
                    </div>
                    <div className="text-2xl font-bold text-primary">
                      {overview.runners.activeJobs}
                    </div>
                  </div>
                  <div className="p-3 border rounded-md bg-muted/30 text-center">
                    <div className="text-xs text-muted-foreground mb-1">
                      Idle Runners
                    </div>
                    <div className="text-2xl font-bold text-muted-foreground">
                      {overview.runners.idleRunners}
                    </div>
                  </div>
                </div>

                <div>
                  <div className="text-sm font-medium mb-3">
                    Runner Pods ({overview.runners.pods.length})
                  </div>
                  <div className="space-y-3">
                    {overview.runners.pods.map((pod) => (
                      <div
                        key={pod.name}
                        className="flex items-center justify-between p-3 border rounded-md bg-muted/30"
                      >
                        <div className="flex items-center gap-3">
                          <div
                            className="font-mono text-sm truncate max-w-[150px]"
                            title={pod.name}
                          >
                            {pod.name}
                          </div>
                          <Badge
                            variant={
                              pod.status === "Running"
                                ? "success"
                                : pod.status === "Pending"
                                  ? "warning"
                                  : pod.status === "Failed" ||
                                      pod.status === "Error"
                                    ? "destructive"
                                    : "secondary"
                            }
                            className="text-[10px] px-1.5 py-0 h-5"
                          >
                            {pod.ready ? "Ready" : pod.status}
                          </Badge>
                        </div>
                        <div className="flex items-center gap-4 text-xs text-muted-foreground font-mono">
                          <div className="flex items-center gap-1" title="CPU">
                            <Cpu className="h-3 w-3" />
                            {pod.cpu ?? "—"}
                          </div>
                          <div
                            className="flex items-center gap-1"
                            title="Memory"
                          >
                            <Activity className="h-3 w-3" />
                            {pod.memory ?? "—"}
                          </div>
                        </div>
                      </div>
                    ))}
                    {overview.runners.pods.length === 0 && (
                      <div className="text-sm text-muted-foreground italic">
                        No runner pods active
                      </div>
                    )}
                  </div>
                </div>
              </div>
            ) : (
              <p className="text-sm text-muted-foreground italic">
                GitHub Actions runners are not enabled. Install ARC and enable
                monitoring in your Helm values.
              </p>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
