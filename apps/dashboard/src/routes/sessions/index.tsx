import { createFileRoute } from "@tanstack/react-router";
import { useMemo } from "react";
import { PageHeader } from "@/components/layout/page-header";
import { SessionList } from "@/components/sessions/session-list";
import { Skeleton } from "@/components/ui/skeleton";
import {
  groupSessionsByAttention,
  useAllSessions,
} from "@/hooks/use-all-sessions";
import { useOpencodeEvents } from "@/hooks/use-opencode-events";

export const Route = createFileRoute("/sessions/")({
  component: SessionsPage,
});

function SessionsPage() {
  useOpencodeEvents();

  const { sessions, isLoading } = useAllSessions();

  const groupedSessions = useMemo(() => {
    const sessionsWithAttention = sessions.map((session) => ({
      ...session,
      attentionState: "none" as const,
    }));

    const grouped = groupSessionsByAttention(sessionsWithAttention);

    return [
      { title: "Needs Attention", sessions: grouped.attention },
      { title: "Running", sessions: grouped.running },
      { title: "Idle", sessions: grouped.idle },
    ];
  }, [sessions]);

  if (isLoading) {
    return (
      <div className="p-6 space-y-6">
        <Skeleton className="h-9 w-48" />
        <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-3">
          {[...Array(6)].map((_, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: Static skeleton placeholders
            <Skeleton key={i} className="h-40" />
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="p-6 space-y-6">
      <PageHeader
        title="Sessions"
        description="All active OpenCode sessions across sandboxes"
      />

      <SessionList
        groups={groupedSessions}
        getAttentionState={(session) => {
          const s = session as typeof session & { attentionState?: string };
          return (
            (s.attentionState as "none" | "waiting" | "retry" | "review") ??
            "none"
          );
        }}
      />
    </div>
  );
}
