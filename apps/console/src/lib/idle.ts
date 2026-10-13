/** Presentation helpers for idle auto-pause (sandbox activity view). */
import type { ActivitySignal, IdleBlocker, IdleState } from "@atelier/spec";
import type { BadgeVariant } from "@/components/ui/badge";
import { formatDuration } from "@/lib/formatters";

/** In display order. */
export const SIGNAL_LABELS: Record<ActivitySignal, string> = {
  ssh: "SSH",
  console: "Console terminal",
  agent: "Agent turns (ACP)",
  api: "API / MCP changes",
  network: "Network traffic",
  files: "File writes",
  cpu: "CPU",
  lifecycle: "Started or resumed",
};

export const BLOCKER_LABELS: Record<IdleBlocker, string> = {
  "keep-awake": "kept awake",
  "agent-turn": "an agent is working",
  "permission-pending": "an agent waits for a permission answer",
  job: "a job is working on it",
  "lifecycle-op": "a lifecycle operation is running",
  "agent-unreported":
    "its agent doesn't report network/file activity (image built before idle auto-pause)",
};

export function idleStatePresentation(state: IdleState): {
  label: string;
  variant: BadgeVariant;
} {
  switch (state) {
    case "active":
      return { label: "In use", variant: "success" };
    case "due":
      return { label: "Idle", variant: "warning" };
    case "blocked":
      return { label: "Held awake", variant: "info" };
    case "off":
      return { label: "Auto-pause off", variant: "neutral" };
    case "not-running":
      return { label: "Not running", variant: "neutral" };
  }
}

/** The keep-awake durations to offer, up to the operator's maximum. */
export function keepAwakeChoices(
  maxHours: number,
): { label: string; value: string }[] {
  const hours = [1, 2, 4, 8, 24].filter((h) => h < maxHours);
  hours.push(maxHours);
  return hours.map((h) => ({
    label: formatDuration(h * 3_600_000),
    value: String(h),
  }));
}

/** A keep-awake choice → the `keepAwakeUntil` to send. */
export function keepAwakeUntil(choice: string, now = Date.now()): string {
  return new Date(now + Number(choice) * 3_600_000).toISOString();
}
