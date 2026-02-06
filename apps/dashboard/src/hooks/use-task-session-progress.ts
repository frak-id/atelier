import type { Task } from "@frak/atelier-manager/types";
import type { Session, Todo } from "@opencode-ai/sdk/v2";
import { useQueries, useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { opencodeSessionsQuery, opencodeTodosQuery } from "@/api/queries";
import {
  type AggregatedInteractionState,
  aggregateInteractions,
  type MappedSessionStatus,
  type SessionInteractionInfo,
} from "@/lib/opencode-helpers";
import type { SessionWithSandboxInfo } from "@/lib/session-hierarchy";
import {
  buildSessionHierarchy,
  flattenHierarchy,
  type SessionNode,
} from "@/lib/session-hierarchy";
import { useOpencodeData } from "./use-opencode-data";

export type { AggregatedInteractionState, MappedSessionStatus };

export interface SessionInteractionState {
  sessionId: string;
  status: MappedSessionStatus;
  pendingPermissions: SessionInteractionInfo["pendingPermissions"];
  pendingQuestions: SessionInteractionInfo["pendingQuestions"];
  todos: Todo[];
}

export interface TodoProgress {
  completed: number;
  inProgress: number;
  pending: number;
  total: number;
}

export interface TaskSessionProgressResult {
  hierarchy: SessionNode[];

  totalCount: number;
  allCount: number;
  subsessionCount: number;

  completedSubsessionCount: number;
  progressPercent: number;

  sessionInteractions: SessionInteractionState[];

  aggregatedInteraction: AggregatedInteractionState;
  needsAttention: boolean;
  hasBusySessions: boolean;

  todoProgress: TodoProgress;
  currentTask: string | null;

  isLoading: boolean;
  isSessionsLoading: boolean;
  isInteractionsLoading: boolean;
  isTodosLoading: boolean;
}

export function useTaskSessionProgress(
  task?: Task,
  opencodeUrl?: string,
  sandboxInfo?: {
    id: string;
    workspaceId?: string;
  },
  enabled = true,
): TaskSessionProgressResult {
  const { data: sessions, isLoading: isSessionsLoading } = useQuery({
    ...opencodeSessionsQuery(opencodeUrl ?? ""),
    enabled: enabled && !!opencodeUrl,
  });

  const {
    permissions,
    questions,
    sessionStatuses,
    isLoading: isInteractionsLoading,
  } = useOpencodeData(opencodeUrl, enabled);

  const hierarchyData = useMemo(() => {
    const taskSessionIds = new Set(
      task?.data.sessions?.map((s: { id: string }) => s.id) ?? [],
    );

    const sessionsWithSandbox: SessionWithSandboxInfo[] = (sessions ?? []).map(
      (session: Session) => ({
        ...session,
        sandbox: {
          id: sandboxInfo?.id ?? "",
          workspaceId: sandboxInfo?.workspaceId,
          opencodeUrl: opencodeUrl ?? "",
        },
      }),
    );

    const hierarchy = buildSessionHierarchy(sessionsWithSandbox);
    const filteredRoots = hierarchy.filter((node) =>
      taskSessionIds.has(node.session.id),
    );

    const allSessions = flattenHierarchy(filteredRoots);

    return {
      taskSessionIds,
      sessionsWithSandbox,
      hierarchy,
      filteredRoots,
      allSessions,
      allSessionIds: allSessions.map((s) => s.id),
    };
  }, [
    task?.data?.sessions,
    sessions,
    sandboxInfo?.id,
    sandboxInfo?.workspaceId,
    opencodeUrl,
  ]);

  const todosResults = useQueries({
    queries: hierarchyData.allSessionIds.map((sessionId) => ({
      ...opencodeTodosQuery(opencodeUrl ?? "", sessionId),
      enabled: enabled && !!opencodeUrl && !!sessionId,
    })),
  });

  const isTodosLoading = todosResults.some((r) => r.isLoading);

  const todosBySession = useMemo(() => {
    const map = new Map<string, Todo[]>();
    for (let i = 0; i < hierarchyData.allSessionIds.length; i++) {
      const sessionId = hierarchyData.allSessionIds[i];
      if (sessionId) {
        const result = todosResults[i];
        map.set(sessionId, (result?.data ?? []) as Todo[]);
      }
    }
    return map;
  }, [hierarchyData.allSessionIds, todosResults]);

  return useMemo(() => {
    const { interactions, aggregated, needsAttention, hasBusySessions } =
      aggregateInteractions(
        hierarchyData.allSessions.map((s) => s.id),
        sessionStatuses,
        permissions,
        questions,
      );

    const sessionInteractions: SessionInteractionState[] =
      hierarchyData.allSessions.map((session) => {
        const interaction = interactions.get(session.id);
        return {
          sessionId: session.id,
          status: interaction?.status ?? "unknown",
          pendingPermissions: interaction?.pendingPermissions ?? [],
          pendingQuestions: interaction?.pendingQuestions ?? [],
          todos: todosBySession.get(session.id) ?? [],
        };
      });

    const completedSubsessionCount = sessionInteractions.filter(
      (s) =>
        s.status === "idle" && !hierarchyData.taskSessionIds.has(s.sessionId),
    ).length;

    const totalSessionCount = hierarchyData.allSessions.length;
    const progressPercent =
      totalSessionCount > 0
        ? Math.round((completedSubsessionCount / totalSessionCount) * 100)
        : 0;

    const allTodos = sessionInteractions.flatMap((s) => s.todos);
    const todoProgress: TodoProgress = {
      completed: allTodos.filter((t) => t.status === "completed").length,
      inProgress: allTodos.filter((t) => t.status === "in_progress").length,
      pending: allTodos.filter((t) => t.status === "pending").length,
      total: allTodos.filter((t) => t.status !== "cancelled").length,
    };

    const currentTask =
      allTodos.find((t) => t.status === "in_progress")?.content ?? null;

    const isLoading =
      isSessionsLoading || isInteractionsLoading || isTodosLoading;

    return {
      hierarchy: hierarchyData.filteredRoots,

      allCount: hierarchyData.allSessions.length,
      totalCount: hierarchyData.filteredRoots.length,
      subsessionCount:
        hierarchyData.allSessions.length - hierarchyData.filteredRoots.length,

      completedSubsessionCount,
      progressPercent,

      sessionInteractions,

      aggregatedInteraction: aggregated,
      needsAttention,
      hasBusySessions,

      todoProgress,
      currentTask,

      isLoading,
      isSessionsLoading,
      isInteractionsLoading,
      isTodosLoading,
    };
  }, [
    hierarchyData,
    sessionStatuses,
    permissions,
    questions,
    todosBySession,
    isSessionsLoading,
    isInteractionsLoading,
    isTodosLoading,
  ]);
}
