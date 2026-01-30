import type { PermissionRequest, QuestionRequest } from "@opencode-ai/sdk/v2";
import { useQueries } from "@tanstack/react-query";
import type { SessionStatus } from "@/api/opencode";
import {
  opencodePermissionsQuery,
  opencodeQuestionsQuery,
  opencodeSessionStatusesQuery,
} from "@/api/queries";
import { aggregateInteractions } from "@/lib/opencode-helpers";
import { useAllOpenCodeSessions } from "./use-all-opencode-sessions";

export function useAttentionCount() {
  const { runningSandboxes, sessions } = useAllOpenCodeSessions();

  const queries = runningSandboxes.flatMap((sandbox) => {
    const baseUrl = sandbox.runtime.urls.opencode;
    return [
      opencodePermissionsQuery(baseUrl),
      opencodeQuestionsQuery(baseUrl),
      opencodeSessionStatusesQuery(baseUrl),
    ] as const;
  });

  const results = useQueries({ queries });

  let totalAttentionCount = 0;

  runningSandboxes.forEach((sandbox, index) => {
    const baseIndex = index * 3;

    const permissions = (results[baseIndex]?.data as PermissionRequest[]) ?? [];
    const questions = (results[baseIndex + 1]?.data as QuestionRequest[]) ?? [];
    const statuses =
      (results[baseIndex + 2]?.data as Record<string, SessionStatus>) ?? {};

    const sandboxSessions = sessions.filter((s) => s.sandbox.id === sandbox.id);
    const sessionIds = sandboxSessions.map((s) => s.id);

    const { aggregated } = aggregateInteractions(
      sessionIds,
      statuses,
      permissions,
      questions,
    );

    totalAttentionCount +=
      aggregated.pendingPermissions.length + aggregated.pendingQuestions.length;
  });

  return totalAttentionCount;
}
