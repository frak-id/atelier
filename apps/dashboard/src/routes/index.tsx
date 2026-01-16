import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import {
  Activity,
  AlertCircle,
  CheckCircle,
  Cpu,
  Database,
  HardDrive,
  Server,
} from "lucide-react";
import {
  healthQuery,
  sandboxListQuery,
  systemStatsQuery,
  systemStorageQuery,
} from "@/api/queries";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { formatBytes, formatDuration } from "@/lib/utils";

export const Route = createFileRoute("/")({
  component: DashboardPage,
  loader: ({ context }) => {
    context.queryClient.ensureQueryData(healthQuery);
    context.queryClient.ensureQueryData(systemStatsQuery);
    context.queryClient.ensureQueryData(systemStorageQuery);
    context.queryClient.ensureQueryData(sandboxListQuery());
  },
  pendingComponent: DashboardSkeleton,
});

function DashboardPage() {
  const { data: health } = useSuspenseQuery(healthQuery);
  const { data: stats } = useSuspenseQuery(systemStatsQuery);
  const { data: storage } = useSuspenseQuery(systemStorageQuery);
  const { data: sandboxes } = useSuspenseQuery(sandboxListQuery());

  const runningSandboxes = sandboxes.filter(
    (s) => s.status === "running",
  ).length;
  const creatingSandboxes = sandboxes.filter(
    (s) => s.status === "creating",
  ).length;

  return (
    <div className="p-6 space-y-6">
      <div>
        <h1 className="text-2xl font-bold sm:text-3xl">Dashboard</h1>
        <p className="text-muted-foreground">
          System overview and health status
        </p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard
          title="System Status"
          value={health.status.toUpperCase()}
          icon={health.status === "ok" ? CheckCircle : AlertCircle}
          description={`Uptime: ${formatDuration(health.uptime)}`}
          variant={health.status === "ok" ? "success" : "warning"}
        />
        <StatCard
          title="Active Sandboxes"
          value={`${runningSandboxes} / ${stats.maxSandboxes}`}
          icon={Server}
          description={
            creatingSandboxes > 0
              ? `${creatingSandboxes} creating`
              : "All running"
          }
        />
        <StatCard
          title="CPU Usage"
          value={`${stats.cpuUsage.toFixed(1)}%`}
          icon={Cpu}
          description={`${stats.activeSandboxes} active VMs`}
        />
        <StatCard
          title="Memory"
          value={`${stats.memoryPercent.toFixed(1)}%`}
          icon={Activity}
          description={`${formatBytes(stats.memoryUsed)} / ${formatBytes(stats.memoryTotal)}`}
        />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Activity className="h-5 w-5" />
              Health Checks
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-3">
              <HealthCheck
                name="Firecracker"
                status={health.checks.firecracker}
              />
              <HealthCheck name="Caddy" status={health.checks.caddy} />
              <HealthCheck name="Network" status={health.checks.network} />
              <HealthCheck name="Storage" status={health.checks.storage} />
              <HealthCheck name="LVM" status={health.checks.lvm} />
            </div>
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
            <div className="space-y-4">
              <div className="flex justify-between items-center">
                <span className="text-sm text-muted-foreground">
                  LVM Available
                </span>
                <Badge variant={storage.available ? "success" : "warning"}>
                  {storage.available ? "Yes" : "No"}
                </Badge>
              </div>
              <div className="flex justify-between items-center">
                <span className="text-sm text-muted-foreground">
                  Base Volume
                </span>
                <Badge variant={storage.hasBaseVolume ? "success" : "error"}>
                  {storage.hasBaseVolume ? "Ready" : "Missing"}
                </Badge>
              </div>
              {storage.pool.exists && (
                <>
                  <div className="flex justify-between items-center">
                    <span className="text-sm text-muted-foreground">
                      Pool Usage
                    </span>
                    <span className="text-sm font-medium">
                      {storage.pool.usedSize} / {storage.pool.totalSize}
                    </span>
                  </div>
                  <div className="flex justify-between items-center">
                    <span className="text-sm text-muted-foreground">
                      Volumes
                    </span>
                    <span className="text-sm font-medium">
                      {storage.pool.volumeCount}
                    </span>
                  </div>
                  <div className="space-y-1">
                    <div className="flex justify-between text-xs">
                      <span>Data</span>
                      <span>{storage.pool.dataPercent.toFixed(1)}%</span>
                    </div>
                    <div className="h-2 bg-secondary rounded-full overflow-hidden">
                      <div
                        className="h-full bg-primary transition-all"
                        style={{ width: `${storage.pool.dataPercent}%` }}
                      />
                    </div>
                  </div>
                </>
              )}
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Database className="h-5 w-5" />
              Disk Usage
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-4">
              <div className="flex justify-between items-center">
                <span className="text-sm text-muted-foreground">Used</span>
                <span className="text-sm font-medium">
                  {formatBytes(stats.diskUsed)} / {formatBytes(stats.diskTotal)}
                </span>
              </div>
              <div className="space-y-1">
                <div className="flex justify-between text-xs">
                  <span>Capacity</span>
                  <span>{stats.diskPercent.toFixed(1)}%</span>
                </div>
                <div className="h-2 bg-secondary rounded-full overflow-hidden">
                  <div
                    className="h-full bg-primary transition-all"
                    style={{ width: `${stats.diskPercent}%` }}
                  />
                </div>
              </div>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Server className="h-5 w-5" />
              Sandboxes Overview
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-3">
              <div className="flex justify-between items-center">
                <span className="text-sm text-muted-foreground">Running</span>
                <Badge variant="success">{runningSandboxes}</Badge>
              </div>
              <div className="flex justify-between items-center">
                <span className="text-sm text-muted-foreground">Creating</span>
                <Badge variant="warning">{creatingSandboxes}</Badge>
              </div>
              <div className="flex justify-between items-center">
                <span className="text-sm text-muted-foreground">Stopped</span>
                <Badge variant="secondary">
                  {sandboxes.filter((s) => s.status === "stopped").length}
                </Badge>
              </div>
              <div className="flex justify-between items-center">
                <span className="text-sm text-muted-foreground">Error</span>
                <Badge variant="error">
                  {sandboxes.filter((s) => s.status === "error").length}
                </Badge>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

function StatCard({
  title,
  value,
  icon: Icon,
  description,
  variant = "default",
}: {
  title: string;
  value: string;
  icon: React.ComponentType<{ className?: string }>;
  description: string;
  variant?: "default" | "success" | "warning";
}) {
  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between pb-2">
        <CardTitle className="text-sm font-medium text-muted-foreground">
          {title}
        </CardTitle>
        <Icon
          className={`h-4 w-4 ${
            variant === "success"
              ? "text-green-500"
              : variant === "warning"
                ? "text-yellow-500"
                : "text-muted-foreground"
          }`}
        />
      </CardHeader>
      <CardContent>
        <div className="text-2xl font-bold">{value}</div>
        <p className="text-xs text-muted-foreground">{description}</p>
      </CardContent>
    </Card>
  );
}

function HealthCheck({
  name,
  status,
}: {
  name: string;
  status: "ok" | "error" | "unavailable";
}) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-sm">{name}</span>
      <Badge
        variant={
          status === "ok" ? "success" : status === "error" ? "error" : "warning"
        }
      >
        {status}
      </Badge>
    </div>
  );
}

function DashboardSkeleton() {
  return (
    <div className="p-6 space-y-6">
      <div>
        <Skeleton className="h-9 w-48" />
        <Skeleton className="h-4 w-64 mt-2" />
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        {[...Array(4)].map((_, i) => (
          <Card key={i}>
            <CardHeader className="pb-2">
              <Skeleton className="h-4 w-24" />
            </CardHeader>
            <CardContent>
              <Skeleton className="h-8 w-16" />
              <Skeleton className="h-3 w-32 mt-2" />
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}
