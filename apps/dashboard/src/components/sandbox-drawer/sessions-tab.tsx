import type { Workspace } from "@frak/atelier-manager/types";
import type { Session, Todo } from "@opencode-ai/sdk/v2";
import { useQueries, useQuery } from "@tanstack/react-query";
import { Bot, Loader2, Plus } from "lucide-react";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { createOpenCodeSession } from "@/api/opencode";
import { opencodeSessionsQuery, opencodeTodosQuery } from "@/api/queries";
import { SessionHierarchy } from "@/components/session-hierarchy";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { useOpencodeData } from "@/hooks/use-opencode-data";
import type { SessionInteractionState } from "@/hooks/use-task-session-progress";
import { aggregateInteractions } from "@/lib/opencode-helpers";
import {
  buildSessionHierarchy,
  flattenHierarchy,
  type SessionWithSandboxInfo,
} from "@/lib/session-hierarchy";
import { getWorkspaceDirectory } from "@/lib/utils";

export function SessionsTabBadge({
  opencodeUrl,
}: {
  opencodeUrl: string | undefined;
  sandboxId: string;
  workspaceId: string | undefined;
}) {
  const { data: sessions } = useQuery({
    ...opencodeSessionsQuery(opencodeUrl ?? ""),
    enabled: !!opencodeUrl,
  });

  const { permissions, questions, sessionStatuses } =
    useOpencodeData(opencodeUrl);

  const needsAttention = useMemo(() => {
    if (!sessions?.length) return false;
    const sessionIds = sessions.map((s: Session) => s.id);
    const { needsAttention } = aggregateInteractions(
      sessionIds,
      sessionStatuses,
      permissions,
      questions,
    );
    return needsAttention;
  }, [sessions, sessionStatuses, permissions, questions]);

  if (!sessions?.length) return null;

  return (
    <>
      <Badge
        variant="secondary"
        className="text-[10px] px-1.5 py-0 h-4 min-w-[1.25rem] justify-center"
      >
        {sessions.length}
      </Badge>
      {needsAttention && (
        <span className="h-2 w-2 rounded-full bg-amber-500 animate-pulse" />
      )}
    </>
  );
}

export function SessionsTab({
  opencodeUrl,
  sandboxId,
  workspaceId,
  workspace,
}: {
  opencodeUrl: string | undefined;
  sandboxId: string;
  workspaceId: string | undefined;
  workspace: Workspace | undefined | null;
}) {
  const [isCreating, setIsCreating] = useState(false);

  const { data: sessions, isLoading: isSessionsLoading } = useQuery({
    ...opencodeSessionsQuery(opencodeUrl ?? ""),
    enabled: !!opencodeUrl,
  });

  const { permissions, questions, sessionStatuses } =
    useOpencodeData(opencodeUrl);

  const directory = getWorkspaceDirectory(workspace);

  const hierarchyData = useMemo(() => {
    const sessionsWithSandbox: SessionWithSandboxInfo[] = (sessions ?? []).map(
      (session: Session) => ({
        ...session,
        sandbox: {
          id: sandboxId,
          workspaceId,
          opencodeUrl: opencodeUrl ?? "",
        },
      }),
    );

    const hierarchy = buildSessionHierarchy(sessionsWithSandbox);
    const allSessions = flattenHierarchy(hierarchy);

    return {
      hierarchy,
      allSessions,
      allSessionIds: allSessions.map((s) => s.id),
    };
  }, [sessions, sandboxId, workspaceId, opencodeUrl]);

  const todosResults = useQueries({
    queries: hierarchyData.allSessionIds.map((sessionId) => ({
      ...opencodeTodosQuery(opencodeUrl ?? "", sessionId),
      enabled: !!opencodeUrl && !!sessionId,
    })),
  });

  const sessionInteractions: SessionInteractionState[] = useMemo(() => {
    const { interactions } = aggregateInteractions(
      hierarchyData.allSessionIds,
      sessionStatuses,
      permissions,
      questions,
    );

    const todosBySession = new Map<string, Todo[]>();
    for (let i = 0; i < hierarchyData.allSessionIds.length; i++) {
      const sessionId = hierarchyData.allSessionIds[i];
      if (sessionId) {
        todosBySession.set(sessionId, (todosResults[i]?.data ?? []) as Todo[]);
      }
    }

    return hierarchyData.allSessions.map((session) => {
      const interaction = interactions.get(session.id);
      return {
        sessionId: session.id,
        status: interaction?.status ?? "unknown",
        pendingPermissions: interaction?.pendingPermissions ?? [],
        pendingQuestions: interaction?.pendingQuestions ?? [],
        todos: todosBySession.get(session.id) ?? [],
      };
    });
  }, [hierarchyData, sessionStatuses, permissions, questions, todosResults]);

  const handleCreateSession = async () => {
    if (!opencodeUrl) return;
    setIsCreating(true);
    try {
      const result = await createOpenCodeSession(opencodeUrl, directory);
      if ("error" in result) {
        toast.error(result.error);
      } else {
        toast.success(`Session created: ${result.sessionId.slice(0, 8)}`);
      }
    } finally {
      setIsCreating(false);
    }
  };

  if (!opencodeUrl) {
    return (
      <Card>
        <CardContent className="py-8">
          <div className="text-center text-muted-foreground">
            <Bot className="h-8 w-8 mx-auto mb-2 opacity-50" />
            <p className="text-sm">OpenCode not available for this sandbox</p>
          </div>
        </CardContent>
      </Card>
    );
  }

  if (isSessionsLoading) {
    return (
      <div className="flex items-center gap-2 text-muted-foreground py-8 justify-center">
        <Loader2 className="h-4 w-4 animate-spin" />
        Loading sessions...
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="text-sm text-muted-foreground">
          {hierarchyData.hierarchy.length} root session
          {hierarchyData.hierarchy.length !== 1 ? "s" : ""}
          {hierarchyData.allSessions.length >
            hierarchyData.hierarchy.length && (
            <span>
              {" "}
              (
              {hierarchyData.allSessions.length -
                hierarchyData.hierarchy.length}{" "}
              sub-sessions)
            </span>
          )}
        </div>
        <Button
          size="sm"
          variant="outline"
          onClick={handleCreateSession}
          disabled={isCreating}
        >
          {isCreating ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin mr-1.5" />
          ) : (
            <Plus className="h-3.5 w-3.5 mr-1.5" />
          )}
          New Session
        </Button>
      </div>

      {hierarchyData.hierarchy.length === 0 ? (
        <Card>
          <CardContent className="py-8">
            <div className="text-center text-muted-foreground">
              <Bot className="h-8 w-8 mx-auto mb-2 opacity-50" />
              <p className="text-sm">No sessions yet</p>
              <p className="text-xs mt-1">
                Create a new session to get started
              </p>
            </div>
          </CardContent>
        </Card>
      ) : (
        <SessionHierarchy
          hierarchy={hierarchyData.hierarchy}
          interactions={sessionInteractions}
          opencodeUrl={opencodeUrl}
          directory={directory}
        />
      )}
    </div>
  );
}
