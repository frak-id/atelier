import { MessageSquare } from "lucide-react";
import type { SessionStatus } from "@/api/opencode";
import { EmptyState } from "@/components/shared/empty-state";
import type { SessionWithSandbox } from "@/hooks/use-all-sessions";
import { SessionCard } from "./session-card";

interface SessionGroup {
  title: string;
  sessions: SessionWithSandbox[];
  statuses?: Map<string, SessionStatus>;
  defaultOpen?: boolean;
}

interface SessionListProps {
  groups: SessionGroup[];
  getAttentionState?: (
    session: SessionWithSandbox,
  ) => "none" | "waiting" | "retry" | "review";
  getStatus?: (session: SessionWithSandbox) => SessionStatus | undefined;
  onReply?: (session: SessionWithSandbox) => void;
}

export function SessionList({
  groups,
  getAttentionState,
  getStatus,
  onReply,
}: SessionListProps) {
  const nonEmptyGroups = groups.filter((g) => g.sessions.length > 0);

  if (nonEmptyGroups.length === 0) {
    return (
      <EmptyState
        icon={MessageSquare}
        title="No active sessions"
        description="Start a task or create a session to see activity here."
      />
    );
  }

  return (
    <div className="space-y-6">
      {nonEmptyGroups.map((group) => (
        <div key={group.title}>
          <h3 className="text-sm font-medium text-muted-foreground mb-3">
            {group.title} ({group.sessions.length})
          </h3>
          <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-3">
            {group.sessions.map((session) => (
              <SessionCard
                key={`${session.sandbox.id}-${session.id}`}
                session={session}
                status={getStatus?.(session)}
                attentionState={getAttentionState?.(session) ?? "none"}
                onReply={onReply ? () => onReply(session) : undefined}
              />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
