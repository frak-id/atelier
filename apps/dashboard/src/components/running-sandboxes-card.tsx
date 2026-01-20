import { useQueries, useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Code2, ExternalLink, Loader2, Server, Trash2 } from "lucide-react";
import { useMemo } from "react";
import type { Sandbox } from "@/api/client";
import {
  opencodeSessionsQuery,
  sandboxListQuery,
  useDeleteSandbox,
  workspaceListQuery,
} from "@/api/queries";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";

export function RunningSandboxesCard() {
  const { data: sandboxes, isLoading: sandboxesLoading } = useQuery(
    sandboxListQuery(),
  );
  const { data: workspaces, isLoading: workspacesLoading } = useQuery(
    workspaceListQuery(),
  );

  const runningSandboxes =
    sandboxes?.filter((s) => s.status === "running") ?? [];

  const workspaceMap = useMemo(() => {
    const map = new Map<string, string>();
    if (workspaces) {
      for (const w of workspaces) {
        map.set(w.id, w.name);
      }
    }
    return map;
  }, [workspaces]);

  const sessionQueries = useQueries({
    queries: runningSandboxes.map((sandbox) =>
      opencodeSessionsQuery(sandbox.runtime.urls.opencode),
    ),
  });

  const sessionCountMap = useMemo(() => {
    const map = new Map<string, number>();
    runningSandboxes.forEach((sandbox, index) => {
      const sessions = sessionQueries[index]?.data ?? [];
      map.set(sandbox.id, sessions.length);
    });
    return map;
  }, [runningSandboxes, sessionQueries]);

  if (sandboxesLoading || workspacesLoading) {
    return (
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-lg flex items-center gap-2">
            <Server className="h-5 w-5" />
            Running Sandboxes
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex items-center justify-center py-8 text-muted-foreground">
            <Loader2 className="h-5 w-5 animate-spin mr-2" />
            Loading...
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
            <Server className="h-5 w-5" />
            Running Sandboxes
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="text-center py-8 text-muted-foreground">
            <Server className="h-10 w-10 mx-auto mb-3 opacity-50" />
            <p>No sandboxes running</p>
            <p className="text-sm mt-1">Start a session to spin up a sandbox</p>
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-lg flex items-center gap-2">
          <Server className="h-5 w-5" />
          Running Sandboxes
          <Badge variant="success" className="ml-auto">
            {runningSandboxes.length}
          </Badge>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-2">
        {runningSandboxes.map((sandbox) => (
          <SandboxRow
            key={sandbox.id}
            sandbox={sandbox}
            workspaceName={
              sandbox.workspaceId
                ? workspaceMap.get(sandbox.workspaceId)
                : undefined
            }
            sessionCount={sessionCountMap.get(sandbox.id) ?? 0}
          />
        ))}
      </CardContent>
    </Card>
  );
}

function SandboxRow({
  sandbox,
  workspaceName,
  sessionCount,
}: {
  sandbox: Sandbox;
  workspaceName?: string;
  sessionCount: number;
}) {
  const deleteMutation = useDeleteSandbox();

  const handleDelete = () => {
    if (confirm(`Delete sandbox ${sandbox.id}?`)) {
      deleteMutation.mutate(sandbox.id);
    }
  };

  const displayName = workspaceName || sandbox.id;

  return (
    <div className="flex items-center justify-between py-2 px-3 rounded-lg hover:bg-muted/50 transition-colors">
      <div className="flex items-center gap-3 min-w-0">
        <div className="flex-1 min-w-0">
          <Link
            to="/sandboxes/$id"
            params={{ id: sandbox.id }}
            className="font-semibold text-base hover:underline truncate block"
          >
            {displayName}
          </Link>
          <div className="flex items-center gap-2 text-xs text-muted-foreground mt-0.5">
            <span className="font-mono">{sandbox.id}</span>
            <span>•</span>
            <span>
              {sessionCount} session{sessionCount !== 1 ? "s" : ""}
            </span>
          </div>
        </div>
      </div>

      <div className="flex items-center gap-1">
        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="ghost" size="icon" className="h-8 w-8" asChild>
              <a
                href={sandbox.runtime.urls.vscode}
                target="_blank"
                rel="noopener noreferrer"
              >
                <Code2 className="h-4 w-4" />
              </a>
            </Button>
          </TooltipTrigger>
          <TooltipContent>Open VSCode</TooltipContent>
        </Tooltip>

        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="ghost" size="icon" className="h-8 w-8" asChild>
              <a
                href={sandbox.runtime.urls.opencode}
                target="_blank"
                rel="noopener noreferrer"
              >
                <ExternalLink className="h-4 w-4" />
              </a>
            </Button>
          </TooltipTrigger>
          <TooltipContent>Open OpenCode</TooltipContent>
        </Tooltip>

        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8"
              onClick={handleDelete}
              disabled={deleteMutation.isPending}
            >
              <Trash2 className="h-4 w-4 text-destructive" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Delete sandbox</TooltipContent>
        </Tooltip>
      </div>
    </div>
  );
}
