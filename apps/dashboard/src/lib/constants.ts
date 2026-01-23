export const SIDEBAR_WIDTH_EXPANDED = 256;
export const SIDEBAR_WIDTH_COLLAPSED = 64;

export const STATUS_COLORS = {
  running: "text-green-500",
  idle: "text-gray-400",
  attention: "text-red-500",
  review: "text-amber-500",
  queued: "text-yellow-500",
  retry: "text-orange-500",
  complete: "text-green-500",
  draft: "text-gray-500",
} as const;

export const STATUS_BG_COLORS = {
  running: "bg-green-500/10",
  idle: "bg-gray-500/10",
  attention: "bg-red-500/10",
  review: "bg-amber-500/10",
  queued: "bg-yellow-500/10",
  retry: "bg-orange-500/10",
  complete: "bg-green-500/10",
  draft: "bg-gray-500/10",
} as const;

export const TASK_STATUS_LABELS = {
  draft: "Draft",
  queued: "Queued",
  in_progress: "In Progress",
  pending_review: "Review",
  completed: "Completed",
} as const;

export type AttentionState = "none" | "waiting" | "retry" | "review";

export const POLLING_INTERVALS = {
  fast: 2000,
  normal: 5000,
  slow: 10000,
  verySlow: 30000,
} as const;

export const STALE_TIMES = {
  short: 5000,
  medium: 30000,
  long: 60000,
} as const;
