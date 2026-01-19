import type { Session } from "@opencode-ai/sdk/v2";
import { useQueries, useQuery } from "@tanstack/react-query";
import { opencodeSessionsQuery, sandboxListQuery } from "@/api/queries";

export type SessionWithSandbox = Session & {
  sandbox: {
    id: string;
    workspaceId: string | undefined;
    opencodeUrl: string;
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
      ...opencodeSessionsQuery(sandbox.runtime.urls.opencode),
      select: (sessions: Session[]) =>
        sessions.map((session) => ({
          ...session,
          sandbox: {
            id: sandbox.id,
            workspaceId: sandbox.workspaceId,
            opencodeUrl: sandbox.runtime.urls.opencode,
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
