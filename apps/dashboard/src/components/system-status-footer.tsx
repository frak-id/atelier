import { useQuery } from "@tanstack/react-query";
import { AlertCircle, CheckCircle, ChevronUp, Server } from "lucide-react";
import { useState } from "react";
import { healthQuery, sandboxListQuery, systemStatsQuery } from "@/api/queries";
import { Badge } from "@/components/ui/badge";

export function SystemStatusFooter() {
  const [expanded, setExpanded] = useState(false);

  const { data: health } = useQuery(healthQuery);
  const { data: stats } = useQuery(systemStatsQuery);
  const { data: sandboxes } = useQuery(sandboxListQuery());

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
            <Server className="h-3.5 w-3.5" />
            {runningSandboxes}/{maxSandboxes} VMs
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
          <div>
            <div className="text-sm font-medium mb-2">Health Checks</div>
            <div className="flex flex-wrap gap-2">
              {health && (
                <>
                  <HealthBadge
                    name="Kubernetes"
                    status={health.checks.kubernetes}
                  />
                  <HealthBadge name="Kata" status={health.checks.kata} />
                  <HealthBadge
                    name="Registry"
                    status={health.checks.registry}
                  />
                </>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
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
