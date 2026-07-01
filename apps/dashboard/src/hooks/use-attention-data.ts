import type {
  AgentPermissionRequest,
  AgentQuestionRequest,
} from "@frak/atelier-shared";
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
  workspaceName?: string;
  type: "permission" | "question";
  summary: string;
  raw:
    | { kind: "permission"; request: AgentPermissionRequest }
    | { kind: "question"; request: AgentQuestionRequest };
};

export type SandboxAttentionGroup = {
  sandboxId: string;
  workspaceName?: string;
  permissions: AgentPermissionRequest[];
  questions: AgentQuestionRequest[];
};

export function useAttentionData() {
  const { data: sandboxes } = useQuery(sandboxListQuery());
  const runningSandboxes =
    sandboxes?.filter((s) => s.status === "running") ?? [];

  const workspaceMap = useWorkspaceMap();

  const queries = useQueries({
    queries: runningSandboxes.flatMap((sandbox) => {
      return [
        {
          ...opencodePermissionsQuery(sandbox.id),
          meta: { sandboxId: sandbox.id, type: "permissions" },
        },
        {
          ...opencodeQuestionsQuery(sandbox.id),
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

    const permissions = (permQuery.data ?? []) as AgentPermissionRequest[];
    const questions = (quesQuery.data ?? []) as AgentQuestionRequest[];

    const workspaceName = sandbox.workspaceId
      ? workspaceMap.get(sandbox.workspaceId)
      : undefined;

    if (permissions.length > 0 || questions.length > 0) {
      groups.push({
        sandboxId: sandbox.id,
        workspaceName,
        permissions,
        questions,
      });
    }

    for (const p of permissions) {
      items.push({
        id: `perm-${sandbox.id}-${p.sessionId}-${p.id}`,
        sandboxId: sandbox.id,
        workspaceName,
        type: "permission",
        summary: `Requesting permission: ${p.permission}`,
        raw: { kind: "permission", request: p },
      });
    }

    for (const q of questions) {
      items.push({
        id: `ques-${sandbox.id}-${q.sessionId}-${q.id}`,
        sandboxId: sandbox.id,
        workspaceName,
        type: "question",
        summary: getQuestionDisplayText(q),
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
