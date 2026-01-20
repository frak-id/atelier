import { Loader2, MessageSquare } from "lucide-react";
import { SessionRow } from "@/components/session-row";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useAllOpenCodeSessions } from "@/hooks/use-all-opencode-sessions";

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
          <SessionRow key={session.id} session={session} showSandboxInfo />
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
