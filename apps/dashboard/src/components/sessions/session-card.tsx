import { ExternalLink } from "lucide-react";
import type { SessionStatus } from "@/api/opencode";
import { QuickActions } from "@/components/shared/quick-actions";
import { TimeAgo } from "@/components/shared/time-ago";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { SessionWithSandbox } from "@/hooks/use-all-sessions";
import { buildOpenCodeSessionUrl, cn } from "@/lib/utils";
import { SessionStatusBadge } from "./status-badge";

interface SessionCardProps {
  session: SessionWithSandbox;
  status?: SessionStatus;
  attentionState?: "none" | "waiting" | "retry" | "review";
  lastMessage?: string;
  onReply?: () => void;
  className?: string;
}

export function SessionCard({
  session,
  status,
  attentionState = "none",
  lastMessage,
  onReply,
  className,
}: SessionCardProps) {
  const opencodeUrl = buildOpenCodeSessionUrl(
    session.sandbox.opencodeUrl,
    session.directory || "",
    session.id,
  );

  const hasAttention = attentionState !== "none";

  return (
    <Card
      className={cn(
        "transition-colors",
        hasAttention && "border-red-500/50 bg-red-500/5",
        className,
      )}
    >
      <CardHeader className="pb-2">
        <div className="flex items-start justify-between gap-2">
          <div className="flex-1 min-w-0">
            <CardTitle className="text-base truncate">
              {session.title || session.id}
            </CardTitle>
            {session.sandbox.workspaceId && (
              <p className="text-xs text-muted-foreground mt-0.5">
                {session.sandbox.workspaceId}
              </p>
            )}
          </div>
          <SessionStatusBadge status={status} attentionState={attentionState} />
        </div>
      </CardHeader>

      <CardContent className="space-y-3">
        {lastMessage && (
          <div className="text-sm text-muted-foreground bg-muted/50 rounded-md p-2 line-clamp-2">
            {lastMessage}
          </div>
        )}

        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <QuickActions
              vscodeUrl={`vscode://vscode-remote/ssh-remote+${session.sandbox.id}/home/dev/workspace`}
              opencodeUrl={opencodeUrl}
            />
            {hasAttention && onReply && (
              <Button size="sm" variant="default" onClick={onReply}>
                Reply
              </Button>
            )}
          </div>

          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            {session.time.updated && <TimeAgo date={session.time.updated} />}
            <Button
              variant="ghost"
              size="sm"
              className="h-7 w-7 p-0"
              onClick={() => window.open(opencodeUrl, "_blank")}
            >
              <ExternalLink className="h-3.5 w-3.5" />
            </Button>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
