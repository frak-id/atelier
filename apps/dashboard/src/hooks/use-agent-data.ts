import type {
  AgentPermissionRequest,
  AgentQuestionRequest,
  AgentSessionStatus,
} from "@frak/atelier-shared";
import { useQueries } from "@tanstack/react-query";
import {
  agentPermissionsQuery,
  agentQuestionsQuery,
  agentSessionStatusesQuery,
} from "@/api/queries";

export interface AgentData {
  permissions: AgentPermissionRequest[];
  questions: AgentQuestionRequest[];
  sessionStatuses: Record<string, AgentSessionStatus>;
  isLoading: boolean;
  isError: boolean;
}

export function useAgentData(
  sandboxId: string | undefined,
  enabled = true,
): AgentData {
  const isEnabled = enabled && !!sandboxId;
  const id = sandboxId ?? "";

  const results = useQueries({
    queries: [
      {
        ...agentPermissionsQuery(id),
        enabled: isEnabled,
      },
      {
        ...agentQuestionsQuery(id),
        enabled: isEnabled,
      },
      {
        ...agentSessionStatusesQuery(id),
        enabled: isEnabled,
      },
    ],
  });

  const [permissionsResult, questionsResult, statusesResult] = results;

  return {
    permissions: (permissionsResult.data ?? []) as AgentPermissionRequest[],
    questions: (questionsResult.data ?? []) as AgentQuestionRequest[],
    sessionStatuses: (statusesResult.data ?? {}) as Record<
      string,
      AgentSessionStatus
    >,
    isLoading: results.some((r) => r.isLoading),
    isError: results.some((r) => r.isError),
  };
}
