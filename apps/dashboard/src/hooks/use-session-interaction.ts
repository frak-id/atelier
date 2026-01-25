import { useMemo } from "react";
import {
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
