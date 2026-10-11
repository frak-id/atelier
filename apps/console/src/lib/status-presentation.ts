import type {
  AgentSessionStatus,
  AgentTodo,
  PermissionRisk,
} from "@frak/atelier-shared";
import type { VariantProps } from "class-variance-authority";
import type { BadgeVariant } from "@/components/ui/badge";
import type { statusDotVariants } from "@/components/ui/status-dot";

type StatusDotVariant = NonNullable<
  VariantProps<typeof statusDotVariants>["variant"]
>;

export interface SessionStatusPresentation {
  label: string;
  badgeVariant: BadgeVariant;
  dotVariant: StatusDotVariant;
  /** Calm-pulse the status dot for states that need attention. */
  pulse: boolean;
}

/** Humanises an `AgentSessionStatus` into one consistent chip everywhere a
 * session's live state is shown (sessions list, home mission control). */
export function sessionStatusPresentation(
  status: AgentSessionStatus | undefined,
): SessionStatusPresentation {
  if (!status) {
    return {
      label: "unknown",
      badgeVariant: "outline",
      dotVariant: "neutral",
      pulse: false,
    };
  }
  switch (status.type) {
    case "busy":
      return {
        label: "Working…",
        badgeVariant: "warning",
        dotVariant: "warning",
        pulse: true,
      };
    case "retry":
      return {
        label: `Retrying (${status.attempt})`,
        badgeVariant: "danger",
        dotVariant: "danger",
        pulse: true,
      };
    case "idle":
      return {
        label: "Idle",
        badgeVariant: "neutral",
        dotVariant: "neutral",
        pulse: false,
      };
    default:
      return status; // exhaustive: `status` is `never` here
  }
}

const TODO_ICON: Record<AgentTodo["status"], string> = {
  pending: "○",
  in_progress: "◐",
  completed: "●",
  cancelled: "✕",
};

export function todoIcon(status: AgentTodo["status"]): string {
  return TODO_ICON[status];
}

/** `3/7 · "writing tests"` — completed/total plus the current in-progress
 * item, for a one-line summary before a session row is expanded. */
export function summarizeTodos(todos: AgentTodo[]): string | null {
  if (todos.length === 0) return null;
  const completed = todos.filter(
    (t) => t.status === "completed" || t.status === "cancelled",
  ).length;
  const current = todos.find((t) => t.status === "in_progress");
  const progress = `${completed}/${todos.length}`;
  return current ? `${progress} · "${current.content}"` : progress;
}

export function riskBadgeVariant(risk: PermissionRisk): BadgeVariant {
  switch (risk) {
    case "high":
      return "danger";
    case "medium":
      return "warning";
    case "low":
      return "neutral";
    default:
      return risk; // exhaustive: `risk` is `never` here
  }
}
