import type { AgentSessionStatus, AgentTodo } from "@frak/atelier-shared";
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

// ── permission humanising (plain-language prompts, IMPLEMENTATION_PLAN.md §5.2) ──

export type PermissionRisk = "low" | "medium" | "high";

export interface PermissionPresentation {
  /** Plain-language label — what the agent wants to do. */
  what: string;
  risk: PermissionRisk;
  riskLabel: string;
}

/**
 * `permission` is free text from the harness (an ACP tool-call title/kind,
 * e.g. "Edit file", "bash", "webfetch") — there's no fixed enum to switch on
 * (see packages/shared/src/agent.schema.ts). Humanise + classify risk with a
 * keyword heuristic; unknown kinds fall back to a medium-risk, verbatim label
 * rather than guessing low (never under-warn on something we don't recognise).
 */
export function permissionPresentation(
  permission: string,
): PermissionPresentation {
  const lower = permission.toLowerCase();
  const has = (...needles: string[]) => needles.some((n) => lower.includes(n));

  if (has("delete", "remove", "rm ")) {
    return { what: "Delete files", risk: "high", riskLabel: "Destructive" };
  }
  if (has("exec", "bash", "shell", "run")) {
    return { what: "Run a command", risk: "high", riskLabel: "Runs code" };
  }
  if (has("write", "edit", "patch", "create")) {
    return { what: "Edit files", risk: "medium", riskLabel: "Changes files" };
  }
  if (has("fetch", "network", "http", "web")) {
    return {
      what: "Access the network",
      risk: "medium",
      riskLabel: "Network access",
    };
  }
  if (has("read", "view", "list")) {
    return { what: "Read files", risk: "low", riskLabel: "Read-only" };
  }
  return { what: permission, risk: "medium", riskLabel: "Unrecognised" };
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
