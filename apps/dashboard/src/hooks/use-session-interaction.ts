import { useMemo } from "react";
import {
  getSessionInteraction,
  type SessionInteractionInfo,
} from "@/lib/agent-helpers";
import { useAgentData } from "./use-agent-data";

export type {
  AgentPermissionRequest as PermissionRequest,
  AgentQuestionRequest as QuestionRequest,
} from "@frak/atelier-shared";

export function useSessionInteraction(
  sandboxId: string | undefined,
  sessionId: string,
  enabled = true,
): { interaction: SessionInteractionInfo | null; isLoading: boolean } {
  const { permissions, questions, sessionStatuses, isLoading } = useAgentData(
    sandboxId,
    enabled,
  );

  const interaction = useMemo(() => {
    if (!sandboxId || !enabled) return null;

    return getSessionInteraction(
      sessionId,
      sessionStatuses,
      permissions,
      questions,
    );
  }, [sandboxId, enabled, sessionId, sessionStatuses, permissions, questions]);

  return { interaction, isLoading };
}
