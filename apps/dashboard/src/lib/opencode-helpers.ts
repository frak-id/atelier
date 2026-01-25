import type { PermissionRequest, QuestionRequest } from "@opencode-ai/sdk/v2";
import type { SessionStatus } from "@/api/opencode";

export type MappedSessionStatus = "idle" | "busy" | "waiting" | "unknown";

export interface SessionInteractionInfo {
  status: MappedSessionStatus;
  pendingPermissions: PermissionRequest[];
  pendingQuestions: QuestionRequest[];
}

export interface AggregatedInteractionState {
  status: MappedSessionStatus;
  pendingPermissions: Array<PermissionRequest & { sessionId: string }>;
  pendingQuestions: Array<QuestionRequest & { sessionId: string }>;
}

export function mapSessionStatus(
  statusInfo: SessionStatus | undefined,
): MappedSessionStatus {
  if (!statusInfo) return "idle";
  if (statusInfo.type === "idle") return "idle";
  if (statusInfo.type === "busy") return "busy";
  if (statusInfo.type === "retry") return "waiting";
  return "unknown";
}

export function getSessionInteraction(
  sessionId: string,
  statusMap: Record<string, SessionStatus>,
  permissions: PermissionRequest[],
  questions: QuestionRequest[],
): SessionInteractionInfo {
  return {
    status: mapSessionStatus(statusMap[sessionId]),
    pendingPermissions: permissions.filter((p) => p.sessionID === sessionId),
    pendingQuestions: questions.filter((q) => q.sessionID === sessionId),
  };
}

export function aggregateInteractions(
  sessionIds: string[],
  statusMap: Record<string, SessionStatus>,
  permissions: PermissionRequest[],
  questions: QuestionRequest[],
): {
  interactions: Map<string, SessionInteractionInfo>;
  aggregated: AggregatedInteractionState;
  needsAttention: boolean;
  hasBusySessions: boolean;
} {
  const interactions = new Map<string, SessionInteractionInfo>();
  const aggregatedPermissions: Array<
    PermissionRequest & { sessionId: string }
  > = [];
  const aggregatedQuestions: Array<QuestionRequest & { sessionId: string }> =
    [];

  let hasIdleSessions = false;
  let hasBusySessions = false;

  for (const sessionId of sessionIds) {
    const interaction = getSessionInteraction(
      sessionId,
      statusMap,
      permissions,
      questions,
    );
    interactions.set(sessionId, interaction);

    if (interaction.status === "idle") hasIdleSessions = true;
    if (interaction.status === "busy") hasBusySessions = true;

    for (const p of interaction.pendingPermissions) {
      aggregatedPermissions.push({ ...p, sessionId });
    }
    for (const q of interaction.pendingQuestions) {
      aggregatedQuestions.push({ ...q, sessionId });
    }
  }

  const needsAttention =
    aggregatedPermissions.length > 0 || aggregatedQuestions.length > 0;

  return {
    interactions,
    aggregated: {
      status: hasBusySessions ? "busy" : hasIdleSessions ? "idle" : "unknown",
      pendingPermissions: aggregatedPermissions,
      pendingQuestions: aggregatedQuestions,
    },
    needsAttention,
    hasBusySessions,
  };
}
