/** Presentation helpers for idle auto-pause (sandbox activity view, list
 * rows, Launchpad notices). */
import {
  type ActivitySignal,
  type IdleBlocker,
  type IdleState,
  KEEP_AWAKE_FOREVER,
  SANDBOX_IDLE_PAUSED_ANNOTATION,
} from "@atelier/spec";
import type { BadgeVariant } from "@/components/ui/badge";

/** `1 h 48 min`, `12 min`, `2 d 3 h`, `<1 min`. */
export function formatDuration(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 1) return "<1 min";
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    const rest = minutes % 60;
    return rest ? `${hours} h ${rest} min` : `${hours} h`;
  }
  const days = Math.floor(hours / 24);
  const rest = hours % 24;
  return rest ? `${days} d ${rest} h` : `${days} d`;
}

/** Time from now until an ISO timestamp (never negative). */
export function msUntil(iso: string, now = Date.now()): number {
  return Math.max(0, new Date(iso).getTime() - now);
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

export const SIGNAL_LABELS: Record<ActivitySignal, string> = {
  ssh: "SSH",
  console: "Console terminal",
  api: "API / MCP changes",
  lifecycle: "Started or resumed",
  agent: "Agent turns (ACP)",
  networkInbound: "Inbound traffic",
  networkOutbound: "Outbound traffic",
  files: "File writes",
  cpu: "CPU",
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

/** The keep-awake durations to offer, within the operator's bounds. */
export function keepAwakeChoices(limits: {
  maxHours: number;
  allowForever: boolean;
}): { label: string; value: string }[] {
  const hours = [1, 2, 4, 8, 24].filter((h) => h < limits.maxHours);
  hours.push(limits.maxHours);
  const choices = hours.map((h) => ({
    label: formatDuration(h * 3_600_000),
    value: String(h),
  }));
  if (limits.allowForever) {
    choices.push({ label: "until turned off", value: KEEP_AWAKE_FOREVER });
  }
  return choices;
}

/** A keep-awake choice → the `keepAwakeUntil` to send. */
export function keepAwakeUntil(choice: string, now = Date.now()): string {
  if (choice === KEEP_AWAKE_FOREVER) return KEEP_AWAKE_FOREVER;
  return new Date(now + Number(choice) * 3_600_000).toISOString();
}

/** When the idle reaper paused this sandbox (absent for a manual pause). */
export function idlePausedAt(
  annotations: Record<string, string> | undefined,
): string | undefined {
  return annotations?.[SANDBOX_IDLE_PAUSED_ANNOTATION];
}
