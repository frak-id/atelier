import type { PermissionRequest, QuestionRequest } from "@opencode-ai/sdk/v2";
import { useQuery } from "@tanstack/react-query";
import type { SessionStatus } from "@/api/opencode";
import {
  opencodePermissionsQuery,
  opencodeQuestionsQuery,
  opencodeSessionStatusesQuery,
} from "@/api/queries";
import type { SessionInteractionInfo } from "@/components/session-status-indicator";
import type { MappedSessionStatus } from "@/hooks/use-task-session-progress";

export function useSessionInteraction(
  opencodeUrl: string | undefined,
  sessionId: string,
  enabled = true,
): { interaction: SessionInteractionInfo | null; isLoading: boolean } {
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

  if (!opencodeUrl || !enabled) {
    return { interaction: null, isLoading: false };
  }

  const statusMap = (sessionStatusesQuery.data ?? {}) as Record<
    string,
    SessionStatus
  >;
  const allPermissions = permissionsQuery.data ?? [];
  const allQuestions = questionsQuery.data ?? [];

  const statusInfo = statusMap[sessionId];
  let status: MappedSessionStatus = "unknown";

  if (statusInfo) {
    if (statusInfo.type === "idle") status = "idle";
    else if (statusInfo.type === "busy") status = "busy";
    else if (statusInfo.type === "retry") status = "waiting";
  }

  const pendingPermissions = allPermissions.filter(
    (p) => p.sessionID === sessionId,
  );
  const pendingQuestions = allQuestions.filter(
    (q) => q.sessionID === sessionId,
  );

  return {
    interaction: {
      status,
      pendingPermissions,
      pendingQuestions,
    },
    isLoading,
  };
}

export function useMultipleSessionInteractions(
  opencodeUrl: string | undefined,
  sessionIds: string[],
  enabled = true,
): {
  interactions: Map<string, SessionInteractionInfo>;
  isLoading: boolean;
} {
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

  const interactions = new Map<string, SessionInteractionInfo>();

  if (!opencodeUrl || !enabled) {
    return { interactions, isLoading: false };
  }

  const statusMap = (sessionStatusesQuery.data ?? {}) as Record<
    string,
    SessionStatus
  >;
  const allPermissions = permissionsQuery.data ?? [];
  const allQuestions = questionsQuery.data ?? [];

  for (const sessionId of sessionIds) {
    const statusInfo = statusMap[sessionId];
    let status: MappedSessionStatus = "unknown";

    if (statusInfo) {
      if (statusInfo.type === "idle") status = "idle";
      else if (statusInfo.type === "busy") status = "busy";
      else if (statusInfo.type === "retry") status = "waiting";
    }

    const pendingPermissions = allPermissions.filter(
      (p) => p.sessionID === sessionId,
    );
    const pendingQuestions = allQuestions.filter(
      (q) => q.sessionID === sessionId,
    );

    interactions.set(sessionId, {
      status,
      pendingPermissions,
      pendingQuestions,
    });
  }

  return { interactions, isLoading };
}

export type { PermissionRequest, QuestionRequest };
