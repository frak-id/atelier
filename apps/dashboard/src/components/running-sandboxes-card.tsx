import { useQuery } from "@tanstack/react-query";
import { Loader2, Server } from "lucide-react";
import { useMemo } from "react";
import { sandboxListQuery, workspaceListQuery } from "@/api/queries";
import { SandboxRow } from "@/components/sandbox-row";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

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
          />
        ))}
      </CardContent>
    </Card>
  );
}
