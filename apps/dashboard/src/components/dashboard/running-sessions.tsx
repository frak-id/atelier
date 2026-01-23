import { Link } from "@tanstack/react-router";
import { ChevronRight, CircleDot, MessageSquare } from "lucide-react";
import { useMemo } from "react";
import { EmptyState } from "@/components/shared/empty-state";
import { QuickActions } from "@/components/shared/quick-actions";
import { StatusIndicator } from "@/components/shared/status-indicator";
import { TimeAgo } from "@/components/shared/time-ago";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import {
  buildSessionHierarchy,
  countSubSessions,
  type SessionNode,
} from "@/lib/session-hierarchy";

export interface RunningSession {
  id: string;
  parentID?: string | null;
  title: string;
  workspaceName?: string;
  progress?: { current: number; total: number };
  status: "running" | "idle";
  updatedAt: string;
  vscodeUrl?: string;
  sshCommand?: string;
  opencodeUrl?: string;
  time: { updated?: number; created?: number };
}

interface RunningSessionsProps {
  sessions: RunningSession[];
  maxItems?: number;
}

export function RunningSessions({
  sessions,
  maxItems = 5,
}: RunningSessionsProps) {
  const hierarchy = useMemo(() => buildSessionHierarchy(sessions), [sessions]);
  const displayNodes = hierarchy.slice(0, maxItems);
  const hasMore = hierarchy.length > maxItems;

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between pb-2">
        <CardTitle className="flex items-center gap-2 text-base">
          <CircleDot className="h-4 w-4 text-green-500" />
          Running Sessions ({sessions.length})
        </CardTitle>
        {hasMore && (
          <Link to="/sessions">
            <Button variant="ghost" size="sm">
              View all
            </Button>
          </Link>
        )}
      </CardHeader>
      <CardContent>
        {displayNodes.length === 0 ? (
          <EmptyState
            icon={MessageSquare}
            title="No running sessions"
            description="Start a task to begin a new session."
            className="py-6"
          />
        ) : (
          <div className="space-y-3">
            {displayNodes.map((node) => (
              <SessionNodeItem key={node.session.id} node={node} />
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function SessionNodeItem({ node }: { node: SessionNode<RunningSession> }) {
  const { session } = node;
  const childCount = countSubSessions(node);

  return (
    <div className="rounded-lg bg-muted/50">
      <div className="flex items-start gap-3 p-3">
        <StatusIndicator
          status={session.status}
          pulse={session.status === "running"}
          className="mt-1.5"
        />

        <div className="flex-1 min-w-0">
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0">
              <p className="font-medium truncate">{session.title}</p>
              {session.workspaceName && (
                <p className="text-xs text-muted-foreground">
                  {session.workspaceName}
                </p>
              )}
            </div>
            <div className="flex items-center gap-2">
              {childCount > 0 && (
                <span className="text-xs text-muted-foreground bg-muted px-1.5 py-0.5 rounded">
                  {childCount} sub-session{childCount > 1 ? "s" : ""}
                </span>
              )}
              <TimeAgo
                date={session.updatedAt}
                className="text-xs text-muted-foreground shrink-0"
              />
            </div>
          </div>

          {session.progress && (
            <div className="mt-2">
              <div className="flex justify-between text-xs text-muted-foreground mb-1">
                <span>Progress</span>
                <span>
                  {session.progress.current}/{session.progress.total}
                </span>
              </div>
              <Progress
                value={
                  (session.progress.current / session.progress.total) * 100
                }
                className="h-1.5"
              />
            </div>
          )}

          <div className="flex items-center gap-2 mt-2">
            <QuickActions
              vscodeUrl={session.vscodeUrl}
              sshCommand={session.sshCommand}
              opencodeUrl={session.opencodeUrl}
            />
            {session.status === "idle" && (
              <Button size="sm" variant="outline" className="ml-auto">
                Continue
              </Button>
            )}
          </div>
        </div>
      </div>

      {node.children.length > 0 && (
        <div className="border-t border-border/50 ml-6 pl-3 py-2 space-y-1">
          {node.children.slice(0, 3).map((child) => (
            <div
              key={child.session.id}
              className="flex items-center gap-2 text-sm text-muted-foreground"
            >
              <ChevronRight className="h-3 w-3" />
              <span className="truncate">{child.session.title}</span>
              <TimeAgo
                date={child.session.updatedAt}
                className="text-xs ml-auto shrink-0"
              />
            </div>
          ))}
          {node.children.length > 3 && (
            <p className="text-xs text-muted-foreground pl-5">
              +{node.children.length - 3} more
            </p>
          )}
        </div>
      )}
    </div>
  );
}
