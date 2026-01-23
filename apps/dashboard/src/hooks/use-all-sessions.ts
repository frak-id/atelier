import type { Session } from "@opencode-ai/sdk/v2";
import { useQueries, useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import type { SessionStatus } from "@/api/opencode";
import { opencodeSessionsQuery, sandboxListQuery } from "@/api/queries";

export type SessionWithSandbox = Session & {
  sandbox: {
    id: string;
    workspaceId: string | undefined;
    workspaceName?: string;
    opencodeUrl: string;
  };
};

export type EnrichedSession = SessionWithSandbox & {
  attentionState: "none" | "waiting" | "retry" | "review";
  lastMessageFrom?: "user" | "agent";
};

export function useAllSessions() {
  const { data: sandboxes, isLoading: sandboxesLoading } = useQuery(
    sandboxListQuery(),
  );

  const runningSandboxes = useMemo(
    () => sandboxes?.filter((s) => s.status === "running") ?? [],
    [sandboxes],
  );

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

  const allSessions = useMemo(() => {
    return sessionQueries
      .flatMap((q) => q.data ?? [])
      .sort((a, b) => {
        const aTime = a.time.updated || a.time.created;
        const bTime = b.time.updated || b.time.created;
        if (!aTime || !bTime) return 0;
        return new Date(bTime).getTime() - new Date(aTime).getTime();
      }) as SessionWithSandbox[];
  }, [sessionQueries]);

  return {
    sessions: allSessions,
    isLoading,
    runningSandboxes,
  };
}

export function getAttentionState(
  sessionStatus: SessionStatus | undefined,
  lastMessageFrom: "user" | "agent" | undefined,
  taskStatus?: string,
): "none" | "waiting" | "retry" | "review" {
  if (taskStatus === "pending_review") return "review";
  if (sessionStatus?.type === "retry") return "retry";
  if (sessionStatus?.type === "idle" && lastMessageFrom === "agent")
    return "waiting";
  return "none";
}

export function groupSessionsByAttention<T extends { attentionState: string }>(
  sessions: T[],
): {
  attention: T[];
  running: T[];
  idle: T[];
} {
  const attention: T[] = [];
  const running: T[] = [];
  const idle: T[] = [];

  for (const session of sessions) {
    if (session.attentionState !== "none") {
      attention.push(session);
    } else {
      idle.push(session);
    }
  }

  return { attention, running, idle };
}
