import { useQuery, useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { Package, Play, Save, Server, Trash2 } from "lucide-react";
import { useState } from "react";
import {
  registryStatusQuery,
  systemStatsQuery,
  usePurgeRegistryCache,
  useRunRegistryEviction,
  useUpdateRegistrySettings,
} from "@/api/queries";
import { RouteErrorComponent } from "@/components/route-error";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { formatDuration } from "@/lib/utils";

export const Route = createFileRoute("/system/")({
  component: SystemPage,
  loader: ({ context }) => {
    context.queryClient.ensureQueryData(systemStatsQuery);
    context.queryClient.ensureQueryData(registryStatusQuery);
  },
  pendingComponent: () => (
    <div className="p-6 space-y-6">
      <Skeleton className="h-9 w-48" />
      <div className="grid gap-4">
        {[...Array(3)].map((_, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: Static skeleton placeholders never reorder
          <Skeleton key={i} className="h-48" />
        ))}
      </div>
    </div>
  ),
  errorComponent: RouteErrorComponent,
});

function SystemPage() {
  const { data: stats } = useSuspenseQuery(systemStatsQuery);
  const { data: registry } = useQuery(registryStatusQuery);

  const updateRegistrySettings = useUpdateRegistrySettings();
  const purgeRegistryCache = usePurgeRegistryCache();
  const runRegistryEviction = useRunRegistryEviction();

  const [evictionDays, setEvictionDays] = useState<number | undefined>(
    undefined,
  );

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
              <Package className="h-5 w-5" />
              Registry Cache
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {registry ? (
              <>
                <div className="flex items-center gap-2">
                  <span className="text-muted-foreground">Status</span>
                  <Badge variant={registry.online ? "success" : "destructive"}>
                    {registry.online ? "Online" : "Offline"}
                  </Badge>
                </div>

                {registry.online ? (
                  <>
                    <div className="grid grid-cols-1 gap-4 pt-2">
                      <div>
                        <div className="text-xs text-muted-foreground">
                          Cached Packages
                        </div>
                        <div className="text-xl font-bold">
                          {registry.packageCount}
                        </div>
                      </div>
                    </div>

                    <div className="flex items-end gap-2 pt-2 border-t">
                      <div className="flex-1 space-y-2">
                        <span className="text-xs font-medium">
                          Eviction (Days)
                        </span>
                        <div className="flex gap-2">
                          <Input
                            type="number"
                            className="h-8"
                            value={
                              evictionDays ??
                              registry.settings?.evictionDays ??
                              14
                            }
                            onChange={(e) =>
                              setEvictionDays(Number(e.target.value))
                            }
                          />
                          <Button
                            size="sm"
                            variant="ghost"
                            disabled={
                              updateRegistrySettings.isPending ||
                              evictionDays === undefined
                            }
                            onClick={() => {
                              if (evictionDays !== undefined) {
                                updateRegistrySettings.mutate({
                                  evictionDays,
                                });
                                setEvictionDays(undefined);
                              }
                            }}
                          >
                            <Save className="h-4 w-4" />
                          </Button>
                        </div>
                      </div>
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-8"
                        disabled={runRegistryEviction.isPending}
                        onClick={() => runRegistryEviction.mutate()}
                      >
                        <Play className="h-3 w-3 mr-2" />
                        Run Eviction
                      </Button>
                    </div>

                    <div className="pt-2 border-t flex justify-between items-center">
                      <div className="flex items-center gap-2">
                        <span className="text-xs text-muted-foreground">
                          Uplink:
                        </span>
                        <Badge
                          variant={
                            registry.uplink.healthy ? "success" : "warning"
                          }
                          className="text-[10px] px-1 py-0 h-5"
                        >
                          {registry.uplink.healthy ? "Healthy" : "Issues"}
                        </Badge>
                      </div>
                      <Button
                        size="sm"
                        variant="ghost"
                        className="text-destructive hover:text-destructive h-8 px-2"
                        disabled={purgeRegistryCache.isPending}
                        onClick={() =>
                          confirm("Purge all cached packages?") &&
                          purgeRegistryCache.mutate()
                        }
                      >
                        <Trash2 className="h-3 w-3 mr-2" />
                        Purge Cache
                      </Button>
                    </div>
                  </>
                ) : (
                  <p className="text-sm text-muted-foreground">
                    Registry is unreachable
                  </p>
                )}
              </>
            ) : (
              <div className="space-y-2">
                <Skeleton className="h-4 w-full" />
                <Skeleton className="h-4 w-2/3" />
                <Skeleton className="h-20 w-full" />
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
