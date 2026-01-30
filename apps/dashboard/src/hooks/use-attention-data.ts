import type { PermissionRequest, QuestionRequest } from "@opencode-ai/sdk/v2";
import { useQueries, useQuery } from "@tanstack/react-query";
import {
  opencodePermissionsQuery,
  opencodeQuestionsQuery,
  sandboxListQuery,
  useWorkspaceMap,
} from "@/api/queries";
import { getQuestionDisplayText } from "@/lib/intervention-helpers";

export type AttentionItem = {
  id: string; // Composite ID for keying
  sandboxId: string;
  sandboxUrl: string;
  workspaceName?: string;
  type: "permission" | "question";
  summary: string;
  timestamp: string; // ISO string
  opencodeUrl: string;
};

export function useAttentionData() {
  // 1. Get running sandboxes
  const { data: sandboxes } = useQuery(sandboxListQuery());
  const runningSandboxes =
    sandboxes?.filter((s) => s.status === "running") ?? [];

  const workspaceMap = useWorkspaceMap();

  // 2. Fetch permissions/questions for each
  const queries = useQueries({
    queries: runningSandboxes.flatMap((sandbox) => {
      const url = sandbox.runtime.urls.opencode;
      return [
        {
          ...opencodePermissionsQuery(url),
          meta: { sandboxId: sandbox.id, type: "permissions" },
        },
        {
          ...opencodeQuestionsQuery(url),
          meta: { sandboxId: sandbox.id, type: "questions" },
        },
      ];
    }),
  });

  const isLoading = queries.some((q) => q.isLoading);
  const items: AttentionItem[] = [];

  // 3. Aggregate results
  // Since we flattened the queries (2 per sandbox), we iterate by 2s
  for (let i = 0; i < runningSandboxes.length; i++) {
    const sandbox = runningSandboxes[i];
    if (!sandbox) continue;

    const permQuery = queries[i * 2];
    const quesQuery = queries[i * 2 + 1];

    if (!permQuery || !quesQuery) continue;

    const permissions = (permQuery.data ?? []) as PermissionRequest[];
    const questions = (quesQuery.data ?? []) as QuestionRequest[];

    // Map permissions
    for (const p of permissions) {
      items.push({
        id: `perm-${sandbox.id}-${p.sessionID}-${p.id}`,
        sandboxId: sandbox.id,
        sandboxUrl: sandbox.runtime.urls.opencode,
        workspaceName: sandbox.workspaceId
          ? workspaceMap.get(sandbox.workspaceId)
          : undefined,
        type: "permission",
        summary: `Requesting permission: ${p.permission}`,
        timestamp: new Date().toISOString(), // Fallback as timestamp is not available
        opencodeUrl: sandbox.runtime.urls.opencode,
      });
    }

    // Map questions
    for (const q of questions) {
      items.push({
        id: `ques-${sandbox.id}-${q.sessionID}-${q.id}`,
        sandboxId: sandbox.id,
        sandboxUrl: sandbox.runtime.urls.opencode,
        workspaceName: sandbox.workspaceId
          ? workspaceMap.get(sandbox.workspaceId)
          : undefined,
        type: "question",
        summary: getQuestionDisplayText(q),
        timestamp: new Date().toISOString(), // Fallback as timestamp is not available
        opencodeUrl: sandbox.runtime.urls.opencode,
      });
    }
  }

  // Sort by timestamp descending (newest first)
  items.sort(
    (a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime(),
  );

  return {
    items,
    isLoading,
    count: items.length,
  };
}
