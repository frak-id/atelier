import type { Task } from "@frak/atelier-manager/types";
import type { AgentSession, AgentTodo } from "@frak/atelier-shared";
import { useQueries, useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { agentSessionsQuery, agentTodosQuery } from "@/api/queries";
import {
  type AggregatedInteractionState,
  aggregateInteractions,
  type MappedSessionStatus,
  type SessionInteractionInfo,
} from "@/lib/agent-helpers";
import type { SessionWithSandboxInfo } from "@/lib/session-hierarchy";
import {
  buildSessionHierarchy,
  flattenHierarchy,
  type SessionNode,
} from "@/lib/session-hierarchy";
import { useAgentData } from "./use-agent-data";

export type { AggregatedInteractionState, MappedSessionStatus };

export interface SessionInteractionState {
  sessionId: string;
  status: MappedSessionStatus;
  pendingPermissions: SessionInteractionInfo["pendingPermissions"];
  pendingQuestions: SessionInteractionInfo["pendingQuestions"];
  todos: AgentTodo[];
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
  sandboxId?: string,
  workspaceId?: string,
  enabled = true,
): TaskSessionProgressResult {
  const { data: sessions, isLoading: isSessionsLoading } = useQuery({
    ...agentSessionsQuery(sandboxId ?? ""),
    enabled: enabled && !!sandboxId,
  });

  const {
    permissions,
    questions,
    sessionStatuses,
    isLoading: isInteractionsLoading,
  } = useAgentData(sandboxId, enabled);

  const hierarchyData = useMemo(() => {
    const taskSessionIds = new Set(
      task?.data.sessions?.map((s: { id: string }) => s.id) ?? [],
    );

    const sessionsWithSandbox: SessionWithSandboxInfo[] = (sessions ?? []).map(
      (session: AgentSession) => ({
        ...session,
        workspaceId,
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
  }, [task?.data?.sessions, sessions, workspaceId]);

  const todosResults = useQueries({
    queries: hierarchyData.allSessionIds.map((sessionId) => ({
      ...agentTodosQuery(sandboxId ?? "", sessionId),
      enabled: enabled && !!sandboxId && !!sessionId,
    })),
  });

  const isTodosLoading = todosResults.some((r) => r.isLoading);

  const todosBySession = useMemo(() => {
    const map = new Map<string, AgentTodo[]>();
    for (let i = 0; i < hierarchyData.allSessionIds.length; i++) {
      const sessionId = hierarchyData.allSessionIds[i];
      if (sessionId) {
        const result = todosResults[i];
        map.set(sessionId, (result?.data ?? []) as AgentTodo[]);
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
