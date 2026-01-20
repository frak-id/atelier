import { ExternalLink, Loader2, MessageSquare } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  type SessionWithSandbox,
  useAllOpenCodeSessions,
} from "@/hooks/use-all-opencode-sessions";
import { buildOpenCodeSessionUrl, formatRelativeTime } from "@/lib/utils";

export function RecentSessionsCard() {
  const { sessions, isLoading, runningSandboxes } = useAllOpenCodeSessions();

  if (isLoading) {
    return (
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-lg flex items-center gap-2">
            <MessageSquare className="h-5 w-5" />
            Recent Sessions
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex items-center justify-center py-8 text-muted-foreground">
            <Loader2 className="h-5 w-5 animate-spin mr-2" />
            Loading sessions...
          </div>
        </CardContent>
      </Card>
    );
  }

  if (runningSandboxes.length === 0) {
    return (
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-lg flex items-center gap-2">
            <MessageSquare className="h-5 w-5" />
            Recent Sessions
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="text-center py-8 text-muted-foreground">
            <MessageSquare className="h-10 w-10 mx-auto mb-3 opacity-50" />
            <p>No running sandboxes</p>
            <p className="text-sm mt-1">
              Start a session above to begin working
            </p>
          </div>
        </CardContent>
      </Card>
    );
  }

  if (sessions.length === 0) {
    return (
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-lg flex items-center gap-2">
            <MessageSquare className="h-5 w-5" />
            Recent Sessions
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="text-center py-8 text-muted-foreground">
            <MessageSquare className="h-10 w-10 mx-auto mb-3 opacity-50" />
            <p>No sessions yet</p>
            <p className="text-sm mt-1">
              {runningSandboxes.length} sandbox
              {runningSandboxes.length !== 1 ? "es" : ""} running, but no
              OpenCode sessions started
            </p>
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-lg flex items-center gap-2">
          <MessageSquare className="h-5 w-5" />
          Recent Sessions
          <Badge variant="secondary" className="ml-auto">
            {sessions.length}
          </Badge>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-2">
        {sessions.slice(0, 5).map((session) => (
          <SessionRow key={session.id} session={session} />
        ))}
        {sessions.length > 5 && (
          <p className="text-xs text-muted-foreground text-center pt-2">
            +{sessions.length - 5} more sessions
          </p>
        )}
      </CardContent>
    </Card>
  );
}

function SessionRow({ session }: { session: SessionWithSandbox }) {
  const sessionUrl = buildOpenCodeSessionUrl(
    session.sandbox.opencodeUrl,
    session.directory,
    session.id,
  );
  const timeString = session.time.updated || session.time.created;

  return (
    <div className="flex items-center justify-between py-2 px-3 rounded-lg hover:bg-muted/50 transition-colors group">
      <div className="flex-1 min-w-0">
        <div className="font-medium truncate">
          {session.title || `Session ${session.id.slice(0, 8)}`}
        </div>
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          {session.sandbox.workspaceId && (
            <span className="truncate">{session.sandbox.workspaceId}</span>
          )}
          {!session.sandbox.workspaceId && (
            <span className="truncate">{session.sandbox.id}</span>
          )}
          {timeString && (
            <>
              <span>•</span>
              <span>{formatRelativeTime(timeString)}</span>
            </>
          )}
        </div>
      </div>
      <Button
        variant="ghost"
        size="sm"
        className="opacity-0 group-hover:opacity-100 transition-opacity"
        asChild
      >
        <a href={sessionUrl} target="_blank" rel="noopener noreferrer">
          <ExternalLink className="h-4 w-4" />
        </a>
      </Button>
    </div>
  );
}
