import { useQuery } from "@tanstack/react-query";
import {
  Activity,
  AlertCircle,
  Bot,
  CheckCircle,
  ChevronUp,
  Cpu,
  Database,
  HardDrive,
  RefreshCw,
  Server,
} from "lucide-react";
import { useState } from "react";
import {
  healthQuery,
  sandboxListQuery,
  systemSandboxQuery,
  systemStatsQuery,
  systemStorageQuery,
  useSystemSandboxPrebuild,
} from "@/api/queries";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { formatBytes } from "@/lib/utils";

export function SystemStatusFooter() {
  const [expanded, setExpanded] = useState(false);

  const { data: health } = useQuery(healthQuery);
  const { data: systemSandbox } = useQuery(systemSandboxQuery);
  const { data: stats } = useQuery(systemStatsQuery);
  const { data: storage } = useQuery(systemStorageQuery);
  const { data: sandboxes } = useQuery(sandboxListQuery());
  const { mutate: rebuild, isPending: isRebuilding } =
    useSystemSandboxPrebuild();

  const runningSandboxes =
    sandboxes?.filter((s) => s.status === "running").length ?? 0;
  const maxSandboxes = stats?.maxSandboxes ?? 10;

  const isHealthy = health?.status === "ok";

  return (
    <div className="border-t bg-card">
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        className="w-full px-4 py-2 flex items-center justify-between text-sm hover:bg-accent/50 transition-colors"
      >
        <div className="flex items-center gap-4 text-muted-foreground">
          <span className="flex items-center gap-1.5">
            <Cpu className="h-3.5 w-3.5" />
            {stats?.cpuUsage.toFixed(0) ?? "--"}%
          </span>
          <span className="flex items-center gap-1.5">
            <Activity className="h-3.5 w-3.5" />
            {stats?.memoryPercent.toFixed(0) ?? "--"}%
          </span>
          <span className="flex items-center gap-1.5">
            <Server className="h-3.5 w-3.5" />
            {runningSandboxes}/{maxSandboxes} VMs
          </span>
          <span
            className={`flex items-center gap-1.5 ${
              !systemSandbox || systemSandbox.status === "off"
                ? "text-muted-foreground"
                : systemSandbox.status === "booting"
                  ? "text-yellow-500"
                  : systemSandbox.status === "running"
                    ? "text-green-500"
                    : "text-blue-500"
            }`}
          >
            <Bot className="h-3.5 w-3.5" />
            AI:{" "}
            {systemSandbox?.status
              ? systemSandbox.status.charAt(0).toUpperCase() +
                systemSandbox.status.slice(1)
              : "Off"}
          </span>
          <span className="flex items-center gap-1.5">
            {isHealthy ? (
              <CheckCircle className="h-3.5 w-3.5 text-green-500" />
            ) : (
              <AlertCircle className="h-3.5 w-3.5 text-yellow-500" />
            )}
            {isHealthy ? "Healthy" : "Issues"}
          </span>
        </div>
        <ChevronUp
          className={`h-4 w-4 text-muted-foreground transition-transform ${expanded ? "rotate-180" : ""}`}
        />
      </button>

      {expanded && (
        <div className="px-4 py-4 border-t space-y-4">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <div className="space-y-2">
              <div className="flex items-center gap-2 text-sm font-medium">
                <Cpu className="h-4 w-4" />
                CPU Usage
              </div>
              <div className="text-2xl font-bold">
                {stats?.cpuUsage.toFixed(1) ?? "--"}%
              </div>
              <div className="h-2 bg-secondary rounded-full overflow-hidden">
                <div
                  className="h-full bg-primary transition-all"
                  style={{ width: `${stats?.cpuUsage ?? 0}%` }}
                />
              </div>
            </div>

            <div className="space-y-2">
              <div className="flex items-center gap-2 text-sm font-medium">
                <Activity className="h-4 w-4" />
                Memory
              </div>
              <div className="text-2xl font-bold">
                {stats?.memoryPercent.toFixed(1) ?? "--"}%
              </div>
              <div className="text-xs text-muted-foreground">
                {stats
                  ? `${formatBytes(stats.memoryUsed)} / ${formatBytes(stats.memoryTotal)}`
                  : "--"}
              </div>
              <div className="h-2 bg-secondary rounded-full overflow-hidden">
                <div
                  className="h-full bg-primary transition-all"
                  style={{ width: `${stats?.memoryPercent ?? 0}%` }}
                />
              </div>
            </div>

            <div className="space-y-2">
              <div className="flex items-center gap-2 text-sm font-medium">
                <Database className="h-4 w-4" />
                Disk
              </div>
              <div className="text-2xl font-bold">
                {stats?.diskPercent.toFixed(1) ?? "--"}%
              </div>
              <div className="text-xs text-muted-foreground">
                {stats
                  ? `${formatBytes(stats.diskUsed)} / ${formatBytes(stats.diskTotal)}`
                  : "--"}
              </div>
              <div className="h-2 bg-secondary rounded-full overflow-hidden">
                <div
                  className="h-full bg-primary transition-all"
                  style={{ width: `${stats?.diskPercent ?? 0}%` }}
                />
              </div>
            </div>

            <div className="space-y-2">
              <div className="flex items-center gap-2 text-sm font-medium">
                <HardDrive className="h-4 w-4" />
                Storage Pool
              </div>
              <div className="text-2xl font-bold">
                {storage?.pool.dataPercent.toFixed(1) ?? "--"}%
              </div>
              <div className="text-xs text-muted-foreground">
                {storage?.pool.exists
                  ? `${storage.pool.usedSize} / ${storage.pool.totalSize}`
                  : "Not configured"}
              </div>
              <div className="h-2 bg-secondary rounded-full overflow-hidden">
                <div
                  className="h-full bg-primary transition-all"
                  style={{ width: `${storage?.pool.dataPercent ?? 0}%` }}
                />
              </div>
            </div>
          </div>

          <div className="pt-2 border-t">
            <div className="text-sm font-medium mb-2">Health Checks</div>
            <div className="flex flex-wrap gap-2">
              {health && (
                <>
                  <HealthBadge
                    name="Firecracker"
                    status={health.checks.firecracker}
                  />
                  <HealthBadge name="Caddy" status={health.checks.caddy} />
                  <HealthBadge name="Network" status={health.checks.network} />
                  <HealthBadge name="Storage" status={health.checks.storage} />
                  <HealthBadge name="LVM" status={health.checks.lvm} />
                </>
              )}
            </div>
          </div>

          <div className="pt-2 border-t">
            <div className="text-sm font-medium mb-2">System Sandbox</div>
            <div className="flex items-center gap-4">
              <SystemSandboxBadge status={systemSandbox?.status ?? "off"} />

              {systemSandbox?.prebuild && (
                <Badge
                  variant={
                    systemSandbox.prebuild.building
                      ? "warning"
                      : systemSandbox.prebuild.exists
                        ? "success"
                        : "outline"
                  }
                  className="gap-1"
                >
                  {systemSandbox.prebuild.building ? (
                    <RefreshCw className="h-3 w-3 animate-spin" />
                  ) : systemSandbox.prebuild.exists ? (
                    <CheckCircle className="h-3 w-3" />
                  ) : (
                    <AlertCircle className="h-3 w-3" />
                  )}
                  {systemSandbox.prebuild.building
                    ? "Prebuild: Building..."
                    : systemSandbox.prebuild.exists
                      ? "Prebuild: Ready"
                      : "No Prebuild"}
                </Badge>
              )}

              {systemSandbox?.prebuild?.builtAt && (
                <span className="text-xs text-muted-foreground">
                  Built: {formatTimeAgo(systemSandbox.prebuild.builtAt)}
                </span>
              )}

              <Button
                variant="outline"
                size="sm"
                className="h-6 px-2 text-xs gap-1"
                onClick={() => rebuild()}
                disabled={isRebuilding || systemSandbox?.prebuild?.building}
              >
                <RefreshCw
                  className={`h-3 w-3 ${
                    isRebuilding || systemSandbox?.prebuild?.building
                      ? "animate-spin"
                      : ""
                  }`}
                />
                Rebuild
              </Button>

              {systemSandbox?.activeCount !== undefined &&
                systemSandbox.activeCount > 0 && (
                  <span className="text-xs text-muted-foreground">
                    {systemSandbox.activeCount} active sessions
                  </span>
                )}
              {systemSandbox?.uptimeMs && (
                <span className="text-xs text-muted-foreground">
                  Uptime: {formatUptime(systemSandbox.uptimeMs)}
                </span>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function formatTimeAgo(dateStr: string) {
  const date = new Date(dateStr);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMins / 60);

  if (diffHours > 0) return `${diffHours}h ago`;
  if (diffMins > 0) return `${diffMins}m ago`;
  return "just now";
}

function formatUptime(ms: number) {
  const minutes = Math.floor(ms / 60000);
  const hours = Math.floor(minutes / 60);
  if (hours > 0) return `${hours}h ${minutes % 60}m`;
  return `${minutes}m`;
}

function SystemSandboxBadge({ status }: { status: string }) {
  const variant =
    status === "running"
      ? "success"
      : status === "booting"
        ? "warning"
        : status === "idle"
          ? "default"
          : "outline";

  return (
    <Badge variant={variant} className="gap-1">
      <Bot className="h-3 w-3" />
      {status.charAt(0).toUpperCase() + status.slice(1)}
    </Badge>
  );
}

function HealthBadge({
  name,
  status,
}: {
  name: string;
  status: "ok" | "error" | "unavailable" | string;
}) {
  const variant =
    status === "ok" ? "success" : status === "error" ? "error" : "warning";
  return (
    <Badge variant={variant} className="gap-1">
      {status === "ok" ? (
        <CheckCircle className="h-3 w-3" />
      ) : (
        <AlertCircle className="h-3 w-3" />
      )}
      {name}
    </Badge>
  );
}
