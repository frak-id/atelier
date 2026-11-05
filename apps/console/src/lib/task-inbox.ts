/**
 * The task inbox's pure logic: which group a task belongs in, what counts as
 * "seen" (kept in localStorage as taskId → the `updatedAt` last looked at),
 * and which polled changes deserve a browser notification.
 */

/** The fields of a `GET /sessions/tasks` row the inbox logic reads. */
export interface InboxTaskLike {
  taskId: string;
  status: string;
  updatedAt: string;
}

/** taskId → the `updatedAt` the user last saw. */
export type SeenMap = Record<string, string>;

export interface TaskGroups<T> {
  /** Turn finished (idle), not yet looked at. */
  review: T[];
  running: T[];
  /** Failed, not yet looked at. */
  failed: T[];
  /** Everything already looked at, plus cancelled tasks. */
  seen: T[];
}

/** A task is unseen until the user opened or acted on it at (or after) its
 * latest update. */
function isSeen(task: InboxTaskLike, seen: SeenMap): boolean {
  const at = seen[task.taskId];
  return at !== undefined && Date.parse(at) >= Date.parse(task.updatedAt);
}

export function groupTasks<T extends InboxTaskLike>(
  tasks: readonly T[],
  seen: SeenMap,
): TaskGroups<T> {
  const groups: TaskGroups<T> = {
    review: [],
    running: [],
    failed: [],
    seen: [],
  };
  for (const task of tasks) {
    if (task.status === "running") groups.running.push(task);
    else if (isSeen(task, seen)) groups.seen.push(task);
    else if (task.status === "idle") groups.review.push(task);
    else if (task.status === "failed") groups.failed.push(task);
    else groups.seen.push(task);
  }
  return groups;
}

/** What the nav badge and the tab title count: tasks waiting on the user. */
export function attentionCount(
  tasks: readonly InboxTaskLike[],
  seen: SeenMap,
): number {
  const { review, failed } = groupTasks(tasks, seen);
  return review.length + failed.length;
}

/** Mark tasks as seen at their current `updatedAt`. Returns the same map when
 * nothing changed, so callers can skip a write. */
export function markSeen(
  seen: SeenMap,
  tasks: readonly InboxTaskLike[],
): SeenMap {
  let next: SeenMap | undefined;
  for (const task of tasks) {
    if (seen[task.taskId] === task.updatedAt) continue;
    next ??= { ...seen };
    next[task.taskId] = task.updatedAt;
  }
  return next ?? seen;
}

/** Forget ids that no longer exist (closed or evicted tasks). */
export function pruneSeen(
  seen: SeenMap,
  tasks: readonly InboxTaskLike[],
): SeenMap {
  const live = new Set(tasks.map((t) => t.taskId));
  const kept = Object.entries(seen).filter(([id]) => live.has(id));
  return kept.length === Object.keys(seen).length
    ? seen
    : Object.fromEntries(kept);
}

/** Tasks that moved from running to idle/failed between two polls. Tasks not
 * in `previous` are ignored: a first load must not notify for old work. */
export function finishedSince<T extends InboxTaskLike>(
  previous: readonly InboxTaskLike[],
  next: readonly T[],
): T[] {
  const before = new Map(previous.map((t) => [t.taskId, t.status]));
  return next.filter(
    (t) =>
      before.get(t.taskId) === "running" &&
      (t.status === "idle" || t.status === "failed"),
  );
}

const SEEN_KEY = "atelier.taskInboxSeen";
const NOTIFY_KEY = "atelier.taskInboxNotify";

export function loadSeen(): SeenMap {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(SEEN_KEY) ?? "{}");
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {};
    }
    return Object.fromEntries(
      Object.entries(parsed).filter(
        (entry): entry is [string, string] => typeof entry[1] === "string",
      ),
    );
  } catch {
    return {};
  }
}

export function saveSeen(seen: SeenMap): void {
  try {
    localStorage.setItem(SEEN_KEY, JSON.stringify(seen));
  } catch {
    // Private mode / quota: "seen" is a convenience, never an error.
  }
}

export function loadNotifyEnabled(): boolean {
  try {
    return localStorage.getItem(NOTIFY_KEY) === "1";
  } catch {
    return false;
  }
}

export function saveNotifyEnabled(enabled: boolean): void {
  try {
    localStorage.setItem(NOTIFY_KEY, enabled ? "1" : "0");
  } catch {
    // See saveSeen.
  }
}
