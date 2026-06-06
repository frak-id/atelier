import { useQuery, useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { Box, Cpu, HardDrive, Loader2, RefreshCw, Server } from "lucide-react";
import {
  sharedBinariesQuery,
  systemServicesQuery,
  systemStatsQuery,
  useRestartCliProxy,
} from "@/api/queries";
import { RouteErrorComponent } from "@/components/route-error";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { formatDuration } from "@/lib/utils";

export const Route = createFileRoute("/system/")({
  component: SystemPage,
  loader: ({ context }) => {
    context.queryClient.ensureQueryData(systemStatsQuery);
    context.queryClient.ensureQueryData(systemServicesQuery);
    context.queryClient.ensureQueryData(sharedBinariesQuery);
  },
  pendingComponent: () => (
    <div className="p-6 space-y-6">
      <Skeleton className="h-9 w-48" />
      <div className="grid gap-4">
        {[...Array(4)].map((_, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: Static skeleton placeholders never reorder
          <Skeleton key={i} className="h-48" />
        ))}
      </div>
    </div>
  ),
  errorComponent: RouteErrorComponent,
});

const COMPONENT_LABELS: Record<string, string> = {
  manager: "Manager + Dashboard",
  cliproxy: "CLIProxy",
  zot: "Zot Registry",
};

const RESTARTABLE = new Set(["cliproxy"]);

function SystemPage() {
  const { data: stats } = useSuspenseQuery(systemStatsQuery);
  const { data: services } = useQuery(systemServicesQuery);
  const { data: binaries } = useQuery(sharedBinariesQuery);

  const restartCliProxy = useRestartCliProxy();

  const restartMutations: Record<
    string,
    { mutate: () => void; isPending: boolean; confirm: string }
  > = {
    cliproxy: {
      mutate: () => restartCliProxy.mutate(),
      isPending: restartCliProxy.isPending,
      confirm: "Restart CLIProxy? This will pull the latest version.",
    },
  };

  if (!stats) {
    return (
      <div className="p-6">
        <p className="text-muted-foreground">Loading system data...</p>
      </div>
    );
  }

  return (
    <div className="p-6 space-y-6">
      <div>
        <h1 className="text-2xl font-bold sm:text-3xl">System</h1>
        <p className="text-muted-foreground">
          System statistics and maintenance
        </p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Server className="h-5 w-5" />
              System Overview
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <div className="text-xs text-muted-foreground">Uptime</div>
                <div className="text-xl font-bold">
                  {formatDuration(stats.uptime)}
                </div>
              </div>
              <div>
                <div className="text-xs text-muted-foreground">
                  Active Sandboxes
                </div>
                <div className="text-xl font-bold">
                  {stats.activeSandboxes} / {stats.maxSandboxes}
                </div>
              </div>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Box className="h-5 w-5" />
              Shared Binaries
            </CardTitle>
          </CardHeader>
          <CardContent>
            {binaries ? (
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <div className="text-xs text-muted-foreground">OpenCode</div>
                  <div className="text-xl font-bold">
                    {binaries.opencode ? `v${binaries.opencode}` : "—"}
                  </div>
                </div>
                <div>
                  <div className="text-xs text-muted-foreground">
                    Code Server
                  </div>
                  <div className="text-xl font-bold">
                    {binaries.codeServer ? `v${binaries.codeServer}` : "—"}
                  </div>
                </div>
                {binaries.jobStatus && (
                  <div className="col-span-2 pt-2 border-t">
                    <div className="flex items-center gap-2">
                      <span className="text-xs text-muted-foreground">
                        Update job:
                      </span>
                      <Badge
                        variant={
                          binaries.jobStatus === "succeeded"
                            ? "success"
                            : binaries.jobStatus === "active"
                              ? "warning"
                              : binaries.jobStatus === "failed"
                                ? "destructive"
                                : "outline"
                        }
                        className="text-[10px] px-1 py-0 h-5"
                      >
                        {binaries.jobStatus}
                      </Badge>
                      {binaries.lastUpdated && (
                        <span className="text-xs text-muted-foreground">
                          {new Date(binaries.lastUpdated).toLocaleDateString()}
                        </span>
                      )}
                    </div>
                  </div>
                )}
              </div>
            ) : (
              <div className="space-y-2">
                <Skeleton className="h-4 w-full" />
                <Skeleton className="h-4 w-2/3" />
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Cpu className="h-5 w-5" />
            Services
          </CardTitle>
        </CardHeader>
        <CardContent>
          {services ? (
            <div className="space-y-1">
              <div className="grid grid-cols-[1fr_80px_100px_100px_80px_80px_90px] gap-2 px-3 py-2 text-xs font-medium text-muted-foreground border-b">
                <div>Service</div>
                <div>Status</div>
                <div>CPU</div>
                <div>Memory</div>
                <div>Storage</div>
                <div>Restarts</div>
                <div />
              </div>

              {services.system.map((svc) => {
                const pod = svc.pods[0];
                const pvc = svc.pvcs[0];
                const restart = RESTARTABLE.has(svc.component)
                  ? restartMutations[svc.component]
                  : null;

                return (
                  <div
                    key={svc.component}
                    className="grid grid-cols-[1fr_80px_100px_100px_80px_80px_90px] gap-2 px-3 py-2.5 text-sm items-center hover:bg-muted/50 rounded"
                  >
                    <div className="font-medium">
                      {COMPONENT_LABELS[svc.component] ?? svc.component}
                    </div>
                    <div>
                      {pod ? (
                        <Badge
                          variant={pod.ready ? "success" : "warning"}
                          className="text-[10px] px-1.5 py-0 h-5"
                        >
                          {pod.ready ? "Ready" : pod.status}
                        </Badge>
                      ) : (
                        <Badge
                          variant="outline"
                          className="text-[10px] px-1.5 py-0 h-5"
                        >
                          None
                        </Badge>
                      )}
                    </div>
                    <div className="text-xs text-muted-foreground font-mono">
                      {pod?.cpu ?? "—"}
                    </div>
                    <div className="text-xs text-muted-foreground font-mono">
                      {pod?.memory ?? "—"}
                    </div>
                    <div className="text-xs text-muted-foreground font-mono">
                      {pvc?.capacity ?? "—"}
                    </div>
                    <div className="text-xs text-muted-foreground font-mono">
                      {pod?.restarts ?? "—"}
                    </div>
                    <div>
                      {restart && (
                        <Button
                          size="sm"
                          variant="outline"
                          className="h-6 px-2 text-xs gap-1"
                          disabled={restart.isPending}
                          onClick={() =>
                            confirm(restart.confirm) && restart.mutate()
                          }
                        >
                          {restart.isPending ? (
                            <Loader2 className="h-3 w-3 animate-spin" />
                          ) : (
                            <RefreshCw className="h-3 w-3" />
                          )}
                          Restart
                        </Button>
                      )}
                    </div>
                  </div>
                );
              })}

              {services.sandboxes.pods.length > 0 && (
                <>
                  <div className="px-3 pt-4 pb-2 text-xs font-medium text-muted-foreground border-t mt-2">
                    Sandbox Pods
                  </div>
                  {services.sandboxes.pods.map((pod) => {
                    const pvc = services.sandboxes.pvcs.find((p) =>
                      p.name.includes(pod.sandboxId),
                    );
                    return (
                      <div
                        key={pod.name}
                        className="grid grid-cols-[1fr_80px_100px_100px_80px_80px_90px] gap-2 px-3 py-2.5 text-sm items-center hover:bg-muted/50 rounded"
                      >
                        <div
                          className="font-medium truncate"
                          title={pod.sandboxId}
                        >
                          {pod.sandboxId}
                        </div>
                        <div>
                          <Badge
                            variant={pod.ready ? "success" : "warning"}
                            className="text-[10px] px-1.5 py-0 h-5"
                          >
                            {pod.ready ? "Ready" : pod.status}
                          </Badge>
                        </div>
                        <div className="text-xs text-muted-foreground font-mono">
                          {pod.cpu ?? "—"}
                        </div>
                        <div className="text-xs text-muted-foreground font-mono">
                          {pod.memory ?? "—"}
                        </div>
                        <div className="text-xs text-muted-foreground font-mono">
                          {pvc?.capacity ?? "—"}
                        </div>
                        <div className="text-xs text-muted-foreground font-mono">
                          {pod.restarts}
                        </div>
                        <div />
                      </div>
                    );
                  })}
                </>
              )}
            </div>
          ) : (
            <div className="space-y-2">
              <Skeleton className="h-8 w-full" />
              <Skeleton className="h-8 w-full" />
              <Skeleton className="h-8 w-full" />
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <HardDrive className="h-5 w-5" />
            Storage
          </CardTitle>
        </CardHeader>
        <CardContent>
          {services ? (
            <div className="space-y-1">
              <div className="grid grid-cols-[1fr_100px_100px] gap-2 px-3 py-2 text-xs font-medium text-muted-foreground border-b">
                <div>Volume</div>
                <div>Capacity</div>
                <div>Status</div>
              </div>
              {[
                ...services.system.flatMap((svc) => svc.pvcs),
                ...services.sandboxes.pvcs,
              ].map((pvc) => (
                <div
                  key={pvc.name}
                  className="grid grid-cols-[1fr_100px_100px] gap-2 px-3 py-2.5 text-sm items-center hover:bg-muted/50 rounded"
                >
                  <div className="font-mono text-xs truncate" title={pvc.name}>
                    {pvc.name}
                  </div>
                  <div className="text-xs text-muted-foreground font-mono">
                    {pvc.capacity}
                  </div>
                  <div>
                    <Badge
                      variant={pvc.phase === "Bound" ? "success" : "warning"}
                      className="text-[10px] px-1.5 py-0 h-5"
                    >
                      {pvc.phase}
                    </Badge>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="space-y-2">
              <Skeleton className="h-8 w-full" />
              <Skeleton className="h-8 w-full" />
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
