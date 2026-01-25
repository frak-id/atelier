import { createOpencodeClient, type Event } from "@opencode-ai/sdk/v2";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import type { SessionStatus } from "@/api/opencode";
import {
  opencodePermissionsQuery,
  opencodeQuestionsQuery,
  opencodeSessionStatusesQuery,
  queryKeys,
} from "@/api/queries";

/**
 * Hook that subscribes to OpenCode SSE events and invalidates
 * the relevant queries when events occur.
 */
export function useOpencodeEventSubscription(
  opencodeUrl: string | undefined,
  enabled = true,
) {
  const queryClient = useQueryClient();
  const abortControllerRef = useRef<AbortController | null>(null);

  useEffect(() => {
    if (!enabled || !opencodeUrl) {
      return;
    }

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
        if (error instanceof Error && error.name === "AbortError") {
          return;
        }
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
}

export type MappedSessionStatus = "idle" | "busy" | "waiting" | "unknown";

export interface SessionInteraction {
  sessionId: string;
  status: MappedSessionStatus;
  pendingPermissions: Array<{ id: string; permission: string }>;
  pendingQuestions: Array<{ id: string; question: string }>;
}

export interface OpencodeInteractionState {
  available: boolean;
  needsAttention: boolean;
  sessions: SessionInteraction[];
  isLoading: boolean;
}

/**
 * Hook that combines permissions, questions, and session status queries
 * into a unified interaction state for a set of session IDs.
 */
export function useOpencodeInteraction(
  opencodeUrl: string | undefined,
  sessionIds: string[],
  enabled = true,
): OpencodeInteractionState {
  useOpencodeEventSubscription(opencodeUrl, enabled && !!opencodeUrl);

  const permissionsQuery = useQuery({
    ...opencodePermissionsQuery(opencodeUrl ?? ""),
    enabled: enabled && !!opencodeUrl,
  });

  const questionsQuery = useQuery({
    ...opencodeQuestionsQuery(opencodeUrl ?? ""),
    enabled: enabled && !!opencodeUrl,
  });

  const sessionStatusesQuery = useQuery({
    ...opencodeSessionStatusesQuery(opencodeUrl ?? ""),
    enabled: enabled && !!opencodeUrl,
  });

  const isLoading =
    permissionsQuery.isLoading ||
    questionsQuery.isLoading ||
    sessionStatusesQuery.isLoading;

  const available =
    !!opencodeUrl &&
    !permissionsQuery.isError &&
    !questionsQuery.isError &&
    !sessionStatusesQuery.isError;

  const statusMap = (sessionStatusesQuery.data ?? {}) as Record<
    string,
    SessionStatus
  >;
  const allPermissions = permissionsQuery.data ?? [];
  const allQuestions = questionsQuery.data ?? [];

  const sessions: SessionInteraction[] = sessionIds.map((sessionId) => {
    const statusInfo = statusMap[sessionId];
    let status: MappedSessionStatus = "unknown";

    if (statusInfo) {
      if (statusInfo.type === "idle") status = "idle";
      else if (statusInfo.type === "busy") status = "busy";
      else if (statusInfo.type === "retry") status = "waiting";
    }

    const pendingPermissions = allPermissions
      .filter((p) => p.sessionID === sessionId)
      .map((p) => ({ id: p.id, permission: p.permission }));

    const pendingQuestions = allQuestions
      .filter((q) => q.sessionID === sessionId)
      .map((q) => ({
        id: q.id,
        question: q.questions?.[0]?.question ?? "",
      }));

    return {
      sessionId,
      status,
      pendingPermissions,
      pendingQuestions,
    };
  });

  const needsAttention = sessions.some(
    (s) => s.pendingPermissions.length > 0 || s.pendingQuestions.length > 0,
  );

  return {
    available,
    needsAttention,
    sessions,
    isLoading,
  };
}
