import type { Task } from "@frak-sandbox/manager/types";
import type { Session } from "@opencode-ai/sdk/v2";
import { useQuery } from "@tanstack/react-query";
import { opencodeSessionsQuery } from "@/api/queries";
import type { SessionWithSandboxInfo } from "@/components/session-row";
import {
  buildSessionHierarchy,
  type SessionNode,
} from "@/lib/session-hierarchy";

function flattenHierarchy(nodes: SessionNode[]): SessionWithSandboxInfo[] {
  const result: SessionWithSandboxInfo[] = [];
  for (const node of nodes) {
    result.push(node.session);
    if (node.children.length > 0) {
      result.push(...flattenHierarchy(node.children));
    }
  }
  return result;
}

export function useTaskSessionHierarchy(
  task: Task,
  sandboxOpencodeUrl: string | undefined,
  sandboxInfo?: {
    id: string;
    workspaceId: string | undefined;
  },
) {
  const { data: sessions, isLoading } = useQuery(
    opencodeSessionsQuery(sandboxOpencodeUrl ?? ""),
  );

  const taskSessionIds = new Set(
    task.data.sessions?.map((s: { id: string }) => s.id) ?? [],
  );

  const sessionsWithSandbox: SessionWithSandboxInfo[] = (sessions ?? []).map(
    (session: Session) => ({
      ...session,
      sandbox: {
        id: sandboxInfo?.id ?? "",
        workspaceId: sandboxInfo?.workspaceId,
        opencodeUrl: sandboxOpencodeUrl ?? "",
      },
    }),
  );

  const hierarchy = buildSessionHierarchy(sessionsWithSandbox);

  const filteredRoots = hierarchy.filter((node) =>
    taskSessionIds.has(node.session.id),
  );

  const allSessions = flattenHierarchy(filteredRoots);

  const rootSessions = filteredRoots.map((node) => node.session);

  return {
    hierarchy: filteredRoots,
    allSessions,
    rootSessions,
    isLoading,
  };
}
