import type { AgentSession } from "@frak/atelier-shared";
import { useQueries, useQuery } from "@tanstack/react-query";
import { opencodeSessionsQuery, sandboxListQuery } from "@/api/queries";

export type SessionWithSandbox = AgentSession & {
  sandbox: {
    id: string;
    workspaceId: string | undefined;
  };
};

export function useAllOpenCodeSessions() {
  const { data: sandboxes, isLoading: sandboxesLoading } = useQuery(
    sandboxListQuery(),
  );

  const runningSandboxes =
    sandboxes?.filter((s) => s.status === "running") ?? [];

  const sessionQueries = useQueries({
    queries: runningSandboxes.map((sandbox) => ({
      ...opencodeSessionsQuery(sandbox.id),
      select: (sessions: AgentSession[]) =>
        sessions.map((session) => ({
          ...session,
          sandbox: {
            id: sandbox.id,
            workspaceId: sandbox.workspaceId,
          },
        })),
    })),
  });

  const isLoading = sandboxesLoading || sessionQueries.some((q) => q.isLoading);

  const allSessions = sessionQueries
    .flatMap((q) => q.data ?? [])
    .sort((a, b) => {
      const aTime = a.time.updated || a.time.created;
      const bTime = b.time.updated || b.time.created;
      if (!aTime || !bTime) return 0;
      return new Date(bTime).getTime() - new Date(aTime).getTime();
    }) as SessionWithSandbox[];

  return {
    sessions: allSessions,
    isLoading,
    runningSandboxes,
  };
}
