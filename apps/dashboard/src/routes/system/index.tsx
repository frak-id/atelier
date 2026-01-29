import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import {
  AlertCircle,
  Database,
  Download,
  HardDrive,
  RefreshCw,
  Server,
  Trash2,
} from "lucide-react";
import {
  sharedStorageQuery,
  systemQueueQuery,
  systemStatsQuery,
  systemStorageQuery,
  useInstallBinary,
  useRemoveBinary,
  useSystemCleanup,
} from "@/api/queries";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { formatBytes, formatDuration } from "@/lib/utils";

export const Route = createFileRoute("/system/")({
  component: SystemPage,
  loader: ({ context }) => {
    context.queryClient.ensureQueryData(systemStatsQuery);
    context.queryClient.ensureQueryData(systemStorageQuery);
    context.queryClient.ensureQueryData(systemQueueQuery);
    context.queryClient.ensureQueryData(sharedStorageQuery);
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
});

function SystemPage() {
  const { data: stats } = useSuspenseQuery(systemStatsQuery);
  const { data: storage } = useSuspenseQuery(systemStorageQuery);
  const { data: queue } = useSuspenseQuery(systemQueueQuery);
  const { data: sharedStorage } = useSuspenseQuery(sharedStorageQuery);
  const cleanupMutation = useSystemCleanup();
  const installBinary = useInstallBinary();
  const removeBinary = useRemoveBinary();

  if (!stats || !storage || !queue || !sharedStorage) {
    return (
      <div className="p-6">
        <p className="text-muted-foreground">Loading system data...</p>
      </div>
    );
  }

  const handleCleanup = () => {
    if (confirm("Run system cleanup? This will remove orphaned resources.")) {
      cleanupMutation.mutate();
    }
  };

  return (
    <div className="p-6 space-y-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold sm:text-3xl">System</h1>
          <p className="text-muted-foreground">
            System statistics and maintenance
          </p>
        </div>
        <Button
          variant="outline"
          onClick={handleCleanup}
          disabled={cleanupMutation.isPending}
          className="w-full sm:w-auto"
        >
          {cleanupMutation.isPending ? (
            <RefreshCw className="h-4 w-4 mr-2 animate-spin" />
          ) : (
            <Trash2 className="h-4 w-4 mr-2" />
          )}
          Run Cleanup
        </Button>
      </div>

      {cleanupMutation.isSuccess && cleanupMutation.data && (
        <Card className="border-green-500">
          <CardContent className="py-4">
            <div className="flex items-center gap-2 text-green-500 mb-2">
              <AlertCircle className="h-4 w-4" />
              Cleanup completed
            </div>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
              <div>
                <span className="text-muted-foreground">Sockets</span>
                <p>{cleanupMutation.data.socketsRemoved}</p>
              </div>
              <div>
                <span className="text-muted-foreground">Overlays</span>
                <p>{cleanupMutation.data.overlaysRemoved}</p>
              </div>
              <div>
                <span className="text-muted-foreground">TAP Devices</span>
                <p>{cleanupMutation.data.tapDevicesRemoved}</p>
              </div>
              <div>
                <span className="text-muted-foreground">LVM Volumes</span>
                <p>{cleanupMutation.data.lvmVolumesRemoved}</p>
              </div>
              <div>
                <span className="text-muted-foreground">Logs</span>
                <p>{cleanupMutation.data.logsRemoved}</p>
              </div>
              <div>
                <span className="text-muted-foreground">Caddy Routes</span>
                <p>{cleanupMutation.data.caddyRoutesRemoved}</p>
              </div>
              <div>
                <span className="text-muted-foreground">SSH Routes</span>
                <p>{cleanupMutation.data.sshRoutesRemoved}</p>
              </div>
              <div>
                <span className="text-muted-foreground">Space Freed</span>
                <p>{formatBytes(cleanupMutation.data.spaceFreed)}</p>
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Server className="h-5 w-5" />
              System Resources
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div>
              <div className="flex justify-between text-sm mb-1">
                <span>CPU Usage</span>
                <span>{stats.cpuUsage.toFixed(1)}%</span>
              </div>
              <div className="h-2 bg-secondary rounded-full overflow-hidden">
                <div
                  className="h-full bg-primary transition-all"
                  style={{ width: `${Math.min(stats.cpuUsage, 100)}%` }}
                />
              </div>
            </div>
            <div>
              <div className="flex justify-between text-sm mb-1">
                <span>Memory</span>
                <span>
                  {formatBytes(stats.memoryUsed)} /{" "}
                  {formatBytes(stats.memoryTotal)}
                </span>
              </div>
              <div className="h-2 bg-secondary rounded-full overflow-hidden">
                <div
                  className="h-full bg-primary transition-all"
                  style={{ width: `${stats.memoryPercent}%` }}
                />
              </div>
            </div>
            <div>
              <div className="flex justify-between text-sm mb-1">
                <span>Disk</span>
                <span>
                  {formatBytes(stats.diskUsed)} / {formatBytes(stats.diskTotal)}
                </span>
              </div>
              <div className="h-2 bg-secondary rounded-full overflow-hidden">
                <div
                  className="h-full bg-primary transition-all"
                  style={{ width: `${stats.diskPercent}%` }}
                />
              </div>
            </div>
            <div className="pt-2 border-t">
              <div className="flex justify-between text-sm">
                <span>Uptime</span>
                <span>{formatDuration(stats.uptime)}</span>
              </div>
              <div className="flex justify-between text-sm mt-2">
                <span>Active Sandboxes</span>
                <span>
                  {stats.activeSandboxes} / {stats.maxSandboxes}
                </span>
              </div>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Database className="h-5 w-5" />
              LVM Storage
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="flex justify-between items-center">
              <span className="text-muted-foreground">LVM Available</span>
              <Badge variant={storage.available ? "success" : "warning"}>
                {storage.available ? "Yes" : "No"}
              </Badge>
            </div>
            <div className="flex justify-between items-center">
              <span className="text-muted-foreground">Default Image</span>
              <Badge variant={storage.hasDefaultImage ? "success" : "error"}>
                {storage.hasDefaultImage ? "Ready" : "Missing"}
              </Badge>
            </div>
            {storage.pool.exists && (
              <>
                <div className="flex justify-between items-center">
                  <span className="text-muted-foreground">Pool Size</span>
                  <span className="text-sm">
                    {storage.pool.usedSize} / {storage.pool.totalSize}
                  </span>
                </div>
                <div className="flex justify-between items-center">
                  <span className="text-muted-foreground">Volumes</span>
                  <span className="text-sm">{storage.pool.volumeCount}</span>
                </div>
                <div className="space-y-2 pt-2 border-t">
                  <div>
                    <div className="flex justify-between text-xs mb-1">
                      <span>Data Usage</span>
                      <span>{storage.pool.dataPercent.toFixed(1)}%</span>
                    </div>
                    <div className="h-2 bg-secondary rounded-full overflow-hidden">
                      <div
                        className="h-full bg-primary transition-all"
                        style={{ width: `${storage.pool.dataPercent}%` }}
                      />
                    </div>
                  </div>
                  <div>
                    <div className="flex justify-between text-xs mb-1">
                      <span>Metadata Usage</span>
                      <span>{storage.pool.metadataPercent.toFixed(1)}%</span>
                    </div>
                    <div className="h-2 bg-secondary rounded-full overflow-hidden">
                      <div
                        className="h-full bg-primary transition-all"
                        style={{ width: `${storage.pool.metadataPercent}%` }}
                      />
                    </div>
                  </div>
                </div>
              </>
            )}
          </CardContent>
        </Card>

        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <HardDrive className="h-5 w-5" />
              Shared Binaries
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex items-center gap-2 mb-4 text-sm text-muted-foreground">
              <Badge
                variant={sharedStorage.image.exists ? "success" : "warning"}
              >
                {sharedStorage.image.exists ? "Built" : "Not Built"}
              </Badge>
              {sharedStorage.image.exists && (
                <>
                  <span>·</span>
                  <span>{formatBytes(sharedStorage.image.sizeBytes ?? 0)}</span>
                  {sharedStorage.image.builtAt && (
                    <>
                      <span>·</span>
                      <span>
                        Built{" "}
                        {new Date(sharedStorage.image.builtAt).toLocaleString()}
                      </span>
                    </>
                  )}
                </>
              )}
            </div>
            <div className="space-y-2">
              {sharedStorage.binaries.map((binary) => (
                <div
                  key={binary.id}
                  className="flex items-center justify-between p-3 bg-muted rounded-lg"
                >
                  <div className="min-w-0 flex-1">
                    <div className="font-medium">{binary.name}</div>
                    <div className="text-xs text-muted-foreground">
                      v{binary.version}
                      {binary.installed && binary.sizeBytes && (
                        <> · {formatBytes(binary.sizeBytes)}</>
                      )}
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <Badge variant={binary.installed ? "success" : "secondary"}>
                      {binary.installed ? "Installed" : "Not Installed"}
                    </Badge>
                    {binary.installed ? (
                      <Button
                        size="sm"
                        variant="destructive"
                        onClick={() => removeBinary.mutate(binary.id)}
                        disabled={removeBinary.isPending}
                      >
                        {removeBinary.isPending &&
                        removeBinary.variables === binary.id ? (
                          <RefreshCw className="h-3 w-3 animate-spin" />
                        ) : (
                          <Trash2 className="h-3 w-3" />
                        )}
                      </Button>
                    ) : (
                      <Button
                        size="sm"
                        onClick={() => installBinary.mutate(binary.id)}
                        disabled={installBinary.isPending}
                      >
                        {installBinary.isPending &&
                        installBinary.variables === binary.id ? (
                          <RefreshCw className="h-3 w-3 animate-spin" />
                        ) : (
                          <Download className="h-3 w-3" />
                        )}
                      </Button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>

        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle>Spawn Queue</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-2 md:grid-cols-5 gap-4 mb-6">
              <div className="text-center p-3 bg-muted rounded-lg">
                <div className="text-2xl font-bold">{queue.stats.queued}</div>
                <div className="text-xs text-muted-foreground">Queued</div>
              </div>
              <div className="text-center p-3 bg-muted rounded-lg">
                <div className="text-2xl font-bold">{queue.stats.running}</div>
                <div className="text-xs text-muted-foreground">Running</div>
              </div>
              <div className="text-center p-3 bg-muted rounded-lg">
                <div className="text-2xl font-bold">
                  {queue.stats.completed}
                </div>
                <div className="text-xs text-muted-foreground">Completed</div>
              </div>
              <div className="text-center p-3 bg-muted rounded-lg">
                <div className="text-2xl font-bold">{queue.stats.failed}</div>
                <div className="text-xs text-muted-foreground">Failed</div>
              </div>
              <div className="text-center p-3 bg-muted rounded-lg">
                <div className="text-2xl font-bold">
                  {queue.stats.maxConcurrent}
                </div>
                <div className="text-xs text-muted-foreground">
                  Max Concurrent
                </div>
              </div>
            </div>

            {(queue.running.length > 0 || queue.queued.length > 0) && (
              <div className="space-y-4">
                {queue.running.length > 0 && (
                  <div>
                    <h4 className="text-sm font-medium mb-2">Running Jobs</h4>
                    <div className="space-y-2">
                      {queue.running.map((job) => (
                        <div
                          key={job.id}
                          className="flex items-center justify-between p-2 bg-muted rounded"
                        >
                          <span className="font-mono text-sm">{job.id}</span>
                          <div className="flex items-center gap-2">
                            {job.workspaceId && (
                              <Badge variant="outline">{job.workspaceId}</Badge>
                            )}
                            <Badge variant="warning">Running</Badge>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
                {queue.queued.length > 0 && (
                  <div>
                    <h4 className="text-sm font-medium mb-2">Queued Jobs</h4>
                    <div className="space-y-2">
                      {queue.queued.map((job) => (
                        <div
                          key={job.id}
                          className="flex items-center justify-between p-2 bg-muted rounded"
                        >
                          <span className="font-mono text-sm">{job.id}</span>
                          <div className="flex items-center gap-2">
                            {job.workspaceId && (
                              <Badge variant="outline">{job.workspaceId}</Badge>
                            )}
                            <Badge variant="secondary">Queued</Badge>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
