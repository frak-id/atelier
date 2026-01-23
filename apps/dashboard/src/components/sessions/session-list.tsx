import { ChevronRight, MessageSquare } from "lucide-react";
import { useMemo } from "react";
import type { SessionStatus } from "@/api/opencode";
import { EmptyState } from "@/components/shared/empty-state";
import { TimeAgo } from "@/components/shared/time-ago";
import type { SessionWithSandbox } from "@/hooks/use-all-sessions";
import {
  buildSessionHierarchy,
  countSubSessions,
  type SessionNode,
} from "@/lib/session-hierarchy";
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
        <SessionGroupSection
          key={group.title}
          group={group}
          getAttentionState={getAttentionState}
          getStatus={getStatus}
          onReply={onReply}
        />
      ))}
    </div>
  );
}

function SessionGroupSection({
  group,
  getAttentionState,
  getStatus,
  onReply,
}: {
  group: SessionGroup;
  getAttentionState?: (
    session: SessionWithSandbox,
  ) => "none" | "waiting" | "retry" | "review";
  getStatus?: (session: SessionWithSandbox) => SessionStatus | undefined;
  onReply?: (session: SessionWithSandbox) => void;
}) {
  const hierarchy = useMemo(
    () => buildSessionHierarchy(group.sessions),
    [group.sessions],
  );

  return (
    <div>
      <h3 className="text-sm font-medium text-muted-foreground mb-3">
        {group.title} ({group.sessions.length})
      </h3>
      <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-3">
        {hierarchy.map((node) => (
          <SessionNodeCard
            key={`${node.session.sandbox.id}-${node.session.id}`}
            node={node}
            getAttentionState={getAttentionState}
            getStatus={getStatus}
            onReply={onReply}
          />
        ))}
      </div>
    </div>
  );
}

function SessionNodeCard({
  node,
  getAttentionState,
  getStatus,
  onReply,
}: {
  node: SessionNode<SessionWithSandbox>;
  getAttentionState?: (
    session: SessionWithSandbox,
  ) => "none" | "waiting" | "retry" | "review";
  getStatus?: (session: SessionWithSandbox) => SessionStatus | undefined;
  onReply?: (session: SessionWithSandbox) => void;
}) {
  const { session } = node;
  const childCount = countSubSessions(node);

  return (
    <div className="space-y-0">
      <SessionCard
        session={session}
        status={getStatus?.(session)}
        attentionState={getAttentionState?.(session) ?? "none"}
        onReply={onReply ? () => onReply(session) : undefined}
        childCount={childCount}
      />
      {node.children.length > 0 && (
        <div className="ml-4 mt-1 pl-3 border-l-2 border-muted space-y-1">
          {node.children.slice(0, 3).map((child) => (
            <div
              key={child.session.id}
              className="flex items-center gap-2 text-sm text-muted-foreground py-1"
            >
              <ChevronRight className="h-3 w-3 shrink-0" />
              <span className="truncate flex-1">
                {child.session.title || child.session.id}
              </span>
              {child.session.time.updated && (
                <TimeAgo
                  date={child.session.time.updated}
                  className="text-xs shrink-0"
                />
              )}
            </div>
          ))}
          {node.children.length > 3 && (
            <p className="text-xs text-muted-foreground pl-5">
              +{node.children.length - 3} more sub-sessions
            </p>
          )}
        </div>
      )}
    </div>
  );
}
