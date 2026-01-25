import { useMemo } from "react";
import {
  aggregateInteractions,
  getSessionInteraction,
  type SessionInteractionInfo,
} from "@/lib/opencode-helpers";
import { useOpencodeData } from "./use-opencode-data";

export type { PermissionRequest, QuestionRequest } from "@opencode-ai/sdk/v2";

export function useSessionInteraction(
  opencodeUrl: string | undefined,
  sessionId: string,
  enabled = true,
): { interaction: SessionInteractionInfo | null; isLoading: boolean } {
  const { permissions, questions, sessionStatuses, isLoading } =
    useOpencodeData(opencodeUrl, enabled);

  const interaction = useMemo(() => {
    if (!opencodeUrl || !enabled) return null;

    return getSessionInteraction(
      sessionId,
      sessionStatuses,
      permissions,
      questions,
    );
  }, [
    opencodeUrl,
    enabled,
    sessionId,
    sessionStatuses,
    permissions,
    questions,
  ]);

  return { interaction, isLoading };
}

export function useMultipleSessionInteractions(
  opencodeUrl: string | undefined,
  sessionIds: string[],
  enabled = true,
): {
  interactions: Map<string, SessionInteractionInfo>;
  isLoading: boolean;
} {
  const { permissions, questions, sessionStatuses, isLoading } =
    useOpencodeData(opencodeUrl, enabled);

  const interactions = useMemo(() => {
    if (!opencodeUrl || !enabled) {
      return new Map<string, SessionInteractionInfo>();
    }

    return aggregateInteractions(
      sessionIds,
      sessionStatuses,
      permissions,
      questions,
    ).interactions;
  }, [
    opencodeUrl,
    enabled,
    sessionIds,
    sessionStatuses,
    permissions,
    questions,
  ]);

  return { interactions, isLoading };
}
