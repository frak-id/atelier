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
  id: string;
  sandboxId: string;
  sandboxUrl: string;
  workspaceName?: string;
  type: "permission" | "question";
  summary: string;
  opencodeUrl: string;
  raw:
    | { kind: "permission"; request: PermissionRequest & { sessionId: string } }
    | { kind: "question"; request: QuestionRequest & { sessionId: string } };
};

export type SandboxAttentionGroup = {
  sandboxId: string;
  opencodeUrl: string;
  workspaceName?: string;
  permissions: Array<PermissionRequest & { sessionId: string }>;
  questions: Array<QuestionRequest & { sessionId: string }>;
};

export function useAttentionData() {
  const { data: sandboxes } = useQuery(sandboxListQuery());
  const runningSandboxes =
    sandboxes?.filter((s) => s.status === "running") ?? [];

  const workspaceMap = useWorkspaceMap();

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
  const groups: SandboxAttentionGroup[] = [];

  for (let i = 0; i < runningSandboxes.length; i++) {
    const sandbox = runningSandboxes[i];
    if (!sandbox) continue;

    const permQuery = queries[i * 2];
    const quesQuery = queries[i * 2 + 1];
    if (!permQuery || !quesQuery) continue;

    const permissions = (permQuery.data ?? []) as PermissionRequest[];
    const questions = (quesQuery.data ?? []) as QuestionRequest[];

    const workspaceName = sandbox.workspaceId
      ? workspaceMap.get(sandbox.workspaceId)
      : undefined;

    const enrichedPermissions = permissions.map((p) => ({
      ...p,
      sessionId: p.sessionID,
    }));

    const enrichedQuestions = questions.map((q) => ({
      ...q,
      sessionId: q.sessionID,
    }));

    if (enrichedPermissions.length > 0 || enrichedQuestions.length > 0) {
      groups.push({
        sandboxId: sandbox.id,
        opencodeUrl: sandbox.runtime.urls.opencode,
        workspaceName,
        permissions: enrichedPermissions,
        questions: enrichedQuestions,
      });
    }

    for (const p of enrichedPermissions) {
      items.push({
        id: `perm-${sandbox.id}-${p.sessionID}-${p.id}`,
        sandboxId: sandbox.id,
        sandboxUrl: sandbox.runtime.urls.opencode,
        workspaceName,
        type: "permission",
        summary: `Requesting permission: ${p.permission}`,
        opencodeUrl: sandbox.runtime.urls.opencode,
        raw: { kind: "permission", request: p },
      });
    }

    for (const q of enrichedQuestions) {
      items.push({
        id: `ques-${sandbox.id}-${q.sessionID}-${q.id}`,
        sandboxId: sandbox.id,
        sandboxUrl: sandbox.runtime.urls.opencode,
        workspaceName,
        type: "question",
        summary: getQuestionDisplayText(q),
        opencodeUrl: sandbox.runtime.urls.opencode,
        raw: { kind: "question", request: q },
      });
    }
  }

  return {
    items,
    groups,
    isLoading,
    count: items.length,
  };
}
