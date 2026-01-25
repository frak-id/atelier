import type { Task } from "@frak-sandbox/manager/types";
import type { Session, Todo } from "@opencode-ai/sdk/v2";
import { useQueries, useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { opencodeSessionsQuery, opencodeTodosQuery } from "@/api/queries";
import type { SessionWithSandboxInfo } from "@/components/session-row";
import {
  type AggregatedInteractionState,
  aggregateInteractions,
  type MappedSessionStatus,
  type SessionInteractionInfo,
} from "@/lib/opencode-helpers";
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
  task: Task,
  opencodeUrl: string | undefined,
  sandboxInfo?: {
    id: string;
    workspaceId: string | undefined;
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
      task.data.sessions?.map((s: { id: string }) => s.id) ?? [],
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
    task.data.sessions,
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

  const isLoading =
    isSessionsLoading || isInteractionsLoading || isTodosLoading;

  return useMemo(() => {
    const taskSessionIds = new Set(
      task.data.sessions?.map((s: { id: string }) => s.id) ?? [],
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

    const flattenHierarchy = (
      nodes: SessionNode[],
    ): SessionWithSandboxInfo[] => {
      const result: SessionWithSandboxInfo[] = [];
      for (const node of nodes) {
        result.push(node.session);
        if (node.children.length > 0) {
          result.push(...flattenHierarchy(node.children));
        }
      }
      return result;
    };

    const allSessions = flattenHierarchy(filteredRoots);

    const { interactions, aggregated, needsAttention, hasBusySessions } =
      aggregateInteractions(
        allSessions.map((s) => s.id),
        sessionStatuses,
        permissions,
        questions,
      );

    const sessionInteractions: SessionInteractionState[] = allSessions.map(
      (session) => {
        const interaction = interactions.get(session.id);
        return {
          sessionId: session.id,
          status: interaction?.status ?? "unknown",
          pendingPermissions: interaction?.pendingPermissions ?? [],
          pendingQuestions: interaction?.pendingQuestions ?? [],
          todos: todosBySession.get(session.id) ?? [],
        };
      },
    );

    const completedSubsessionCount = sessionInteractions.filter(
      (s) => s.status === "idle" && !taskSessionIds.has(s.sessionId),
    ).length;

    const totalSessionCount = allSessions.length;
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

    return {
      hierarchy: filteredRoots,

      allCount: allSessions.length,
      totalCount: filteredRoots.length,
      subsessionCount: allSessions.length - filteredRoots.length,

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
    task.data.sessions,
    sessions,
    sessionStatuses,
    permissions,
    questions,
    opencodeUrl,
    sandboxInfo?.id,
    sandboxInfo?.workspaceId,
    todosBySession,
    isLoading,
    isSessionsLoading,
    isInteractionsLoading,
    isTodosLoading,
  ]);
}
