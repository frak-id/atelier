import { useQuery } from "@tanstack/react-query";
import { useCallback, useMemo, useSyncExternalStore } from "react";
import { type InboxTask, tasksListQuery } from "@/api/queries/tasks";
import {
  attentionCount,
  groupTasks,
  loadSeen,
  markSeen,
  pruneSeen,
  type SeenMap,
  saveSeen,
} from "@/lib/task-inbox";

// The seen map is shared by every component that reads the inbox (nav badge,
// home, sandbox pages), so it lives in a tiny store rather than per-hook
// state. localStorage stays the source of truth across tabs.
let seenState: SeenMap | undefined;
const listeners = new Set<() => void>();

function currentSeen(): SeenMap {
  seenState ??= loadSeen();
  return seenState;
}

function setSeen(next: SeenMap): void {
  if (next === seenState) return;
  seenState = next;
  saveSeen(next);
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  const onStorage = () => {
    seenState = loadSeen();
    listener();
  };
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("storage", onStorage);
  };
}

/**
 * The task inbox: one polled query (`GET /sessions/tasks`, shared by every
 * caller through the query cache, so the nav badge and the inbox never poll
 * twice), grouped by what needs the user, plus the local "seen" state.
 */
export function useTaskInbox() {
  const query = useQuery(tasksListQuery());
  const seen = useSyncExternalStore(subscribe, currentSeen);
  const tasks = query.data;

  const groups = useMemo(() => groupTasks(tasks ?? [], seen), [tasks, seen]);
  const attention = useMemo(
    () => (tasks ? attentionCount(tasks, seen) : 0),
    [tasks, seen],
  );

  /** Mark tasks seen at their current update (opening or acting on them). */
  const markTasksSeen = useCallback((list: readonly InboxTask[]) => {
    setSeen(markSeen(currentSeen(), list));
  }, []);

  /** Drop seen entries of tasks that no longer exist. */
  const prune = useCallback(() => {
    if (tasks) setSeen(pruneSeen(currentSeen(), tasks));
  }, [tasks]);

  return {
    tasks,
    groups,
    attention,
    seen,
    isPending: query.isPending,
    isError: query.isError,
    error: query.error,
    markTasksSeen,
    prune,
  };
}
