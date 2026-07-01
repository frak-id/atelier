import type {
  AgentPermissionRequest,
  AgentQuestionRequest,
  AgentSessionStatus,
} from "@frak/atelier-shared";
import { useQueries } from "@tanstack/react-query";
import {
  opencodePermissionsQuery,
  opencodeQuestionsQuery,
  opencodeSessionStatusesQuery,
} from "@/api/queries";

export interface OpencodeData {
  permissions: AgentPermissionRequest[];
  questions: AgentQuestionRequest[];
  sessionStatuses: Record<string, AgentSessionStatus>;
  isLoading: boolean;
  isError: boolean;
}

export function useOpencodeData(
  sandboxId: string | undefined,
  enabled = true,
): OpencodeData {
  const isEnabled = enabled && !!sandboxId;
  const id = sandboxId ?? "";

  const results = useQueries({
    queries: [
      {
        ...opencodePermissionsQuery(id),
        enabled: isEnabled,
      },
      {
        ...opencodeQuestionsQuery(id),
        enabled: isEnabled,
      },
      {
        ...opencodeSessionStatusesQuery(id),
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
