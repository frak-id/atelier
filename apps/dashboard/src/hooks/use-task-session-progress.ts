import type { Task } from "@frak-sandbox/manager/types";
import { useMemo } from "react";

export interface TaskSessionProgress {
  sessions: NonNullable<Task["data"]["sessions"]>;
  completedSessions: NonNullable<Task["data"]["sessions"]>;
  runningSessions: NonNullable<Task["data"]["sessions"]>;
  pendingSessions: NonNullable<Task["data"]["sessions"]>;
  totalCount: number;
  completedCount: number;
  runningCount: number;
  progressPercent: number;
  hasSessions: boolean;
  hasActiveOrCompletedSession: boolean;
  hasRunningSessions: boolean;
  subsessionCount?: number;
  totalWithSubsessions?: number;
}

export function useTaskSessionProgress(
  task: Task,
  options?: {
    includeSubsessions?: boolean;
    allSessions?: NonNullable<Task["data"]["sessions"]>;
  },
): TaskSessionProgress {
  return useMemo(() => {
    const sessions =
      options?.includeSubsessions && options?.allSessions
        ? options.allSessions
        : (task.data.sessions ?? []);

    const completedSessions = sessions.filter((s) => s.status === "completed");
    const runningSessions = sessions.filter((s) => s.status === "running");
    const pendingSessions = sessions.filter((s) => s.status === "pending");
    const totalCount = sessions.length;
    const completedCount = completedSessions.length;
    const runningCount = runningSessions.length;
    const progressPercent =
      totalCount > 0 ? Math.round((completedCount / totalCount) * 100) : 0;

    const hasActiveOrCompletedSession = sessions.some(
      (s) => s.status === "running" || s.status === "completed",
    );

    const subsessionCount =
      options?.includeSubsessions && options?.allSessions
        ? options.allSessions.length - (task.data.sessions?.length ?? 0)
        : undefined;

    const totalWithSubsessions =
      options?.includeSubsessions && options?.allSessions
        ? options.allSessions.length
        : undefined;

    return {
      sessions,
      completedSessions,
      runningSessions,
      pendingSessions,
      totalCount,
      completedCount,
      runningCount,
      progressPercent,
      hasSessions: sessions.length > 0,
      hasActiveOrCompletedSession,
      hasRunningSessions: runningCount > 0,
      subsessionCount,
      totalWithSubsessions,
    };
  }, [task.data.sessions, options?.includeSubsessions, options?.allSessions]);
}
