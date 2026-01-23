import { AlertCircle, Circle, CircleDot, Clock, RefreshCw } from "lucide-react";
import type { SessionStatus } from "@/api/opencode";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

interface SessionStatusBadgeProps {
  status: SessionStatus | undefined;
  attentionState?: "none" | "waiting" | "retry" | "review";
  className?: string;
}

export function SessionStatusBadge({
  status,
  attentionState = "none",
  className,
}: SessionStatusBadgeProps) {
  if (attentionState === "review") {
    return (
      <Badge
        variant="outline"
        className={cn("gap-1 text-amber-500 border-amber-500/50", className)}
      >
        <Clock className="h-3 w-3" />
        Review
      </Badge>
    );
  }

  if (attentionState === "waiting") {
    return (
      <Badge
        variant="outline"
        className={cn("gap-1 text-red-500 border-red-500/50", className)}
      >
        <AlertCircle className="h-3 w-3" />
        Waiting
      </Badge>
    );
  }

  if (!status) {
    return (
      <Badge variant="secondary" className={cn("gap-1", className)}>
        <Circle className="h-3 w-3" />
        Unknown
      </Badge>
    );
  }

  switch (status.type) {
    case "busy":
      return (
        <Badge
          variant="outline"
          className={cn("gap-1 text-green-500 border-green-500/50", className)}
        >
          <CircleDot className="h-3 w-3 animate-pulse" />
          Running
        </Badge>
      );

    case "retry":
      return (
        <Badge
          variant="outline"
          className={cn(
            "gap-1 text-orange-500 border-orange-500/50",
            className,
          )}
        >
          <RefreshCw className="h-3 w-3" />
          Retry #{status.attempt}
        </Badge>
      );

    default:
      return (
        <Badge variant="secondary" className={cn("gap-1", className)}>
          <Circle className="h-3 w-3" />
          Idle
        </Badge>
      );
  }
}
