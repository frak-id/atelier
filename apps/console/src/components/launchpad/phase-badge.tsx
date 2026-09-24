import type { WorkspacePhase } from "@/api/queries/launchpad";
import { Badge } from "@/components/ui/badge";
import { StatusDot } from "@/components/ui/status-dot";
import { PHASE_PRESENTATION } from "@/lib/launchpad";
import { cn } from "@/lib/utils";

/** A workspace's status in plain words, with a calm pulse while it moves. */
export function PhaseBadge({
  phase,
  className,
}: {
  phase: WorkspacePhase;
  className?: string;
}) {
  const p = PHASE_PRESENTATION[phase];
  return (
    <Badge variant={p.variant} className={cn("gap-1.5", className)}>
      <StatusDot variant={p.dot} pulse={p.busy} />
      {p.label}
    </Badge>
  );
}
