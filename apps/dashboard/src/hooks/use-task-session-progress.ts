import type { Task } from "@frak-sandbox/manager/types";
import type { Session } from "@opencode-ai/sdk/v2";
import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { opencodeSessionsQuery } from "@/api/queries";
import type { SessionWithSandboxInfo } from "@/components/session-row";
import {
  type AggregatedInteractionState,
  aggregateInteractions,
  type MappedSessionStatus,
  type SessionInteractionInfo,
} from "@/lib/opencode-helpers";
import {
  buildSessionHierarchy,
  type SessionNode,
} from "@/lib/session-hierarchy";
import { useOpencodeData } from "./use-opencode-data";

export type { AggregatedInteractionState, MappedSessionStatus };

export interface SessionInteractionState {
  sessionId: string;
  status: MappedSessionStatus;
  pendingPermissions: SessionInteractionInfo["pendingPermissions"];
  pendingQuestions: SessionInteractionInfo["pendingQuestions"];
}

export interface TaskSessionProgressResult {
  hierarchy: SessionNode[];
  allSessions: SessionWithSandboxInfo[];
  rootSessions: SessionWithSandboxInfo[];

  totalCount: number;
  subsessionCount: number;

  completedSubsessionCount: number;
  progressPercent: number;

  sessionInteractions: SessionInteractionState[];

  aggregatedInteraction: AggregatedInteractionState;
  needsAttention: boolean;
  hasIdleSessions: boolean;
  hasBusySessions: boolean;

  isLoading: boolean;
  isSessionsLoading: boolean;
  isInteractionsLoading: boolean;
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

  const isLoading = isSessionsLoading || isInteractionsLoading;

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
    const rootSessions = filteredRoots.map((node) => node.session);

    const {
      interactions,
      aggregated,
      needsAttention,
      hasIdleSessions,
      hasBusySessions,
    } = aggregateInteractions(
      allSessions.map((s) => s.id),
      sessionStatuses,
      permissions,
      questions,
    );

    const rootSessionIds = new Set(rootSessions.map((s) => s.id));
    const sessionInteractions: SessionInteractionState[] = allSessions.map(
      (session) => {
        const interaction = interactions.get(session.id);
        return {
          sessionId: session.id,
          status: interaction?.status ?? "unknown",
          pendingPermissions: interaction?.pendingPermissions ?? [],
          pendingQuestions: interaction?.pendingQuestions ?? [],
        };
      },
    );

    const completedSubsessionCount = sessionInteractions.filter(
      (s) => s.status === "idle" && !rootSessionIds.has(s.sessionId),
    ).length;

    const totalSessionCount = allSessions.length;
    const progressPercent =
      totalSessionCount > 0
        ? Math.round((completedSubsessionCount / totalSessionCount) * 100)
        : 0;

    return {
      hierarchy: filteredRoots,
      allSessions,
      rootSessions,

      totalCount: rootSessions.length,
      subsessionCount: allSessions.length - rootSessions.length,

      completedSubsessionCount,
      progressPercent,

      sessionInteractions,

      aggregatedInteraction: aggregated,
      needsAttention,
      hasIdleSessions,
      hasBusySessions,

      isLoading,
      isSessionsLoading,
      isInteractionsLoading,
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
    isLoading,
    isSessionsLoading,
    isInteractionsLoading,
  ]);
}
