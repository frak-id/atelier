import type { Task } from "@frak-sandbox/manager/types";
import type {
  PermissionRequest,
  QuestionRequest,
  Session,
} from "@opencode-ai/sdk/v2";
import { createOpencodeClient, type Event } from "@opencode-ai/sdk/v2";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef } from "react";
import type { SessionStatus } from "@/api/opencode";
import {
  opencodePermissionsQuery,
  opencodeQuestionsQuery,
  opencodeSessionStatusesQuery,
  opencodeSessionsQuery,
  queryKeys,
} from "@/api/queries";
import type { SessionWithSandboxInfo } from "@/components/session-row";
import {
  buildSessionHierarchy,
  type SessionNode,
} from "@/lib/session-hierarchy";

export type MappedSessionStatus = "idle" | "busy" | "waiting" | "unknown";

export interface SessionInteractionState {
  sessionId: string;
  status: MappedSessionStatus;
  pendingPermissions: PermissionRequest[];
  pendingQuestions: QuestionRequest[];
}

export interface AggregatedInteractionState {
  status: MappedSessionStatus;
  pendingPermissions: Array<PermissionRequest & { sessionId: string }>;
  pendingQuestions: Array<QuestionRequest & { sessionId: string }>;
}

export interface TaskSessionProgressResult {
  hierarchy: SessionNode[];
  allSessions: SessionWithSandboxInfo[];
  rootSessions: SessionWithSandboxInfo[];

  totalCount: number;
  subsessionCount: number;

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
  const queryClient = useQueryClient();
  const abortControllerRef = useRef<AbortController | null>(null);

  useEffect(() => {
    if (!enabled || !opencodeUrl) return;

    const abortController = new AbortController();
    abortControllerRef.current = abortController;

    const client = createOpencodeClient({ baseUrl: opencodeUrl });

    const subscribeToEvents = async () => {
      try {
        const result = await client.event.subscribe(undefined, {
          signal: abortController.signal,
          sseMaxRetryAttempts: 10,
          sseDefaultRetryDelay: 3000,
          sseMaxRetryDelay: 30000,
        });

        for await (const event of result.stream) {
          if (abortController.signal.aborted) break;
          handleEvent(event as Event);
        }
      } catch (error) {
        if (error instanceof Error && error.name === "AbortError") return;
        console.warn("OpenCode SSE subscription failed:", error);
      }
    };

    const handleEvent = (event: Event) => {
      switch (event.type) {
        case "session.status":
        case "session.idle":
          queryClient.invalidateQueries({
            queryKey: queryKeys.opencode.sessionStatuses(opencodeUrl),
          });
          break;
        case "permission.asked":
        case "permission.replied":
          queryClient.invalidateQueries({
            queryKey: queryKeys.opencode.permissions(opencodeUrl),
          });
          break;
        case "question.asked":
        case "question.replied":
        case "question.rejected":
          queryClient.invalidateQueries({
            queryKey: queryKeys.opencode.questions(opencodeUrl),
          });
          break;
      }
    };

    subscribeToEvents();

    return () => {
      abortController.abort();
      abortControllerRef.current = null;
    };
  }, [enabled, opencodeUrl, queryClient]);

  const { data: sessions, isLoading: isSessionsLoading } = useQuery({
    ...opencodeSessionsQuery(opencodeUrl ?? ""),
    enabled: enabled && !!opencodeUrl,
  });

  const { data: sessionStatuses, isLoading: isStatusesLoading } = useQuery({
    ...opencodeSessionStatusesQuery(opencodeUrl ?? ""),
    enabled: enabled && !!opencodeUrl,
  });

  const { data: permissions, isLoading: isPermissionsLoading } = useQuery({
    ...opencodePermissionsQuery(opencodeUrl ?? ""),
    enabled: enabled && !!opencodeUrl,
  });

  const { data: questions, isLoading: isQuestionsLoading } = useQuery({
    ...opencodeQuestionsQuery(opencodeUrl ?? ""),
    enabled: enabled && !!opencodeUrl,
  });

  const isInteractionsLoading =
    isStatusesLoading || isPermissionsLoading || isQuestionsLoading;
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

    const statusMap = (sessionStatuses ?? {}) as Record<string, SessionStatus>;
    const allPermissions = permissions ?? [];
    const allQuestions = questions ?? [];

    const sessionInteractions: SessionInteractionState[] = allSessions.map(
      (session) => {
        const statusInfo = statusMap[session.id];
        let status: MappedSessionStatus = "unknown";

        if (statusInfo) {
          if (statusInfo.type === "idle") status = "idle";
          else if (statusInfo.type === "busy") status = "busy";
          else if (statusInfo.type === "retry") status = "waiting";
        }

        const pendingPermissions = allPermissions.filter(
          (p) => p.sessionID === session.id,
        );
        const pendingQuestions = allQuestions.filter(
          (q) => q.sessionID === session.id,
        );

        return {
          sessionId: session.id,
          status,
          pendingPermissions,
          pendingQuestions,
        };
      },
    );

    const aggregatedPermissions = sessionInteractions.flatMap((s) =>
      s.pendingPermissions.map((p) => ({ ...p, sessionId: s.sessionId })),
    );
    const aggregatedQuestions = sessionInteractions.flatMap((s) =>
      s.pendingQuestions.map((q) => ({ ...q, sessionId: s.sessionId })),
    );

    const hasIdleSessions = sessionInteractions.some(
      (s) => s.status === "idle",
    );
    const hasBusySessions = sessionInteractions.some(
      (s) => s.status === "busy",
    );
    const needsAttention =
      aggregatedPermissions.length > 0 || aggregatedQuestions.length > 0;

    const aggregatedInteraction: AggregatedInteractionState = {
      status: hasBusySessions ? "busy" : hasIdleSessions ? "idle" : "unknown",
      pendingPermissions: aggregatedPermissions,
      pendingQuestions: aggregatedQuestions,
    };

    return {
      hierarchy: filteredRoots,
      allSessions,
      rootSessions,

      totalCount: rootSessions.length,
      subsessionCount: allSessions.length - rootSessions.length,

      sessionInteractions,

      aggregatedInteraction,
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
