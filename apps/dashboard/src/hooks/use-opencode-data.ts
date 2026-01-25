import type { PermissionRequest, QuestionRequest } from "@opencode-ai/sdk/v2";
import { useQueries } from "@tanstack/react-query";
import type { SessionStatus } from "@/api/opencode";
import {
  opencodePermissionsQuery,
  opencodeQuestionsQuery,
  opencodeSessionStatusesQuery,
} from "@/api/queries";

export interface OpencodeData {
  permissions: PermissionRequest[];
  questions: QuestionRequest[];
  sessionStatuses: Record<string, SessionStatus>;
  isLoading: boolean;
  isError: boolean;
}

export function useOpencodeData(
  opencodeUrl: string | undefined,
  enabled = true,
): OpencodeData {
  const isEnabled = enabled && !!opencodeUrl;
  const url = opencodeUrl ?? "";

  const results = useQueries({
    queries: [
      {
        ...opencodePermissionsQuery(url),
        enabled: isEnabled,
      },
      {
        ...opencodeQuestionsQuery(url),
        enabled: isEnabled,
      },
      {
        ...opencodeSessionStatusesQuery(url),
        enabled: isEnabled,
      },
    ],
  });

  const [permissionsResult, questionsResult, statusesResult] = results;

  return {
    permissions: (permissionsResult.data ?? []) as PermissionRequest[],
    questions: (questionsResult.data ?? []) as QuestionRequest[],
    sessionStatuses: (statusesResult.data ?? {}) as Record<
      string,
      SessionStatus
    >,
    isLoading: results.some((r) => r.isLoading),
    isError: results.some((r) => r.isError),
  };
}
