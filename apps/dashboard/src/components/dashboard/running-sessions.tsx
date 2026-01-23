import { Link } from "@tanstack/react-router";
import { CircleDot, MessageSquare } from "lucide-react";
import { EmptyState } from "@/components/shared/empty-state";
import { QuickActions } from "@/components/shared/quick-actions";
import { StatusIndicator } from "@/components/shared/status-indicator";
import { TimeAgo } from "@/components/shared/time-ago";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";

export interface RunningSession {
  id: string;
  title: string;
  workspaceName?: string;
  progress?: { current: number; total: number };
  status: "running" | "idle";
  updatedAt: string;
  vscodeUrl?: string;
  sshCommand?: string;
  opencodeUrl?: string;
}

interface RunningSessionsProps {
  sessions: RunningSession[];
  maxItems?: number;
}

export function RunningSessions({
  sessions,
  maxItems = 5,
}: RunningSessionsProps) {
  const displaySessions = sessions.slice(0, maxItems);
  const hasMore = sessions.length > maxItems;

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
        {displaySessions.length === 0 ? (
          <EmptyState
            icon={MessageSquare}
            title="No running sessions"
            description="Start a task to begin a new session."
            className="py-6"
          />
        ) : (
          <div className="space-y-3">
            {displaySessions.map((session) => (
              <div
                key={session.id}
                className="flex items-start gap-3 p-3 rounded-lg bg-muted/50"
              >
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
                    <TimeAgo
                      date={session.updatedAt}
                      className="text-xs text-muted-foreground shrink-0"
                    />
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
                          (session.progress.current / session.progress.total) *
                          100
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
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
