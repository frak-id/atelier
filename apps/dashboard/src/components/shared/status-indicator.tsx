import { STATUS_COLORS } from "@/lib/constants";
import { cn } from "@/lib/utils";

export type IndicatorStatus =
  | "running"
  | "idle"
  | "attention"
  | "review"
  | "queued"
  | "retry"
  | "complete"
  | "draft";

interface StatusIndicatorProps {
  status: IndicatorStatus;
  pulse?: boolean;
  size?: "sm" | "md" | "lg";
  className?: string;
}

const sizeClasses = {
  sm: "h-2 w-2",
  md: "h-2.5 w-2.5",
  lg: "h-3 w-3",
} as const;

export function StatusIndicator({
  status,
  pulse = false,
  size = "md",
  className,
}: StatusIndicatorProps) {
  const shouldPulse = pulse || status === "running";

  return (
    <span className={cn("relative inline-flex", className)}>
      <span
        className={cn(
          "rounded-full",
          sizeClasses[size],
          STATUS_COLORS[status],
          shouldPulse && "animate-pulse",
        )}
        style={{
          backgroundColor: "currentColor",
        }}
      />
      {shouldPulse && (
        <span
          className={cn(
            "absolute inline-flex h-full w-full rounded-full opacity-75 animate-ping",
            STATUS_COLORS[status],
          )}
          style={{
            backgroundColor: "currentColor",
          }}
        />
      )}
    </span>
  );
}
