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
import { aggregateInteractions } from "@/lib/opencode-helpers";
import { useAllOpenCodeSessions } from "./use-all-opencode-sessions";

export function useAttentionCount() {
  const { runningSandboxes, sessions } = useAllOpenCodeSessions();

  const queries = runningSandboxes.flatMap((sandbox) => {
    return [
      opencodePermissionsQuery(sandbox.id),
      opencodeQuestionsQuery(sandbox.id),
      opencodeSessionStatusesQuery(sandbox.id),
    ] as const;
  });

  const results = useQueries({ queries });

  let totalAttentionCount = 0;

  runningSandboxes.forEach((sandbox, index) => {
    const baseIndex = index * 3;

    const permissions =
      (results[baseIndex]?.data as AgentPermissionRequest[]) ?? [];
    const questions =
      (results[baseIndex + 1]?.data as AgentQuestionRequest[]) ?? [];
    const statuses =
      (results[baseIndex + 2]?.data as Record<string, AgentSessionStatus>) ??
      {};

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
