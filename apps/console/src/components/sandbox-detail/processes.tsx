import type { ProcessStatus } from "@atelier/spec";
import {
  ChevronDown,
  ChevronRight,
  Loader2,
  Play,
  Square,
  Star,
} from "lucide-react";
import { useState } from "react";
import { useProcessAction } from "@/api/queries/sandboxes";
import { TerminalView } from "@/components/terminal-view";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { StatusDot } from "@/components/ui/status-dot";

export function ProcessesSection({
  sandboxId,
  processes,
}: {
  sandboxId: string;
  processes: ProcessStatus[];
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Processes</CardTitle>
      </CardHeader>
      <CardContent className="space-y-2">
        {processes.length === 0 ? (
          <p className="text-sm text-muted-foreground">No processes.</p>
        ) : (
          processes.map((process) => (
            <ProcessRow
              key={process.name}
              sandboxId={sandboxId}
              process={process}
            />
          ))
        )}
      </CardContent>
    </Card>
  );
}

function ProcessRow({
  sandboxId,
  process,
}: {
  sandboxId: string;
  process: ProcessStatus;
}) {
  const [logsOpen, setLogsOpen] = useState(false);
  const processAction = useProcessAction(sandboxId);

  return (
    <div className="rounded-md border">
      <div className="flex flex-wrap items-center gap-2 p-3">
        <StatusDot variant={process.running ? "success" : "danger"} />
        <span className="sr-only">
          {process.running ? "running" : "stopped"}
        </span>
        <span className="font-mono text-sm">{process.name}</span>
        {process.primary ? (
          <Badge variant="outline" className="flex items-center gap-1">
            <Star className="size-3" />
            primary
          </Badge>
        ) : null}
        {process.ready !== undefined ? (
          <Badge variant={process.ready ? "success" : "warning"}>
            {process.ready ? "ready" : "not ready"}
          </Badge>
        ) : null}
        {process.exitCode !== undefined ? (
          <span className="text-xs text-muted-foreground">
            exit {process.exitCode}
          </span>
        ) : null}
        <div className="ml-auto flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            disabled={processAction.isPending}
            onClick={() =>
              processAction.mutate({
                name: process.name,
                action: process.running ? "stop" : "start",
              })
            }
          >
            {processAction.isPending ? (
              <Loader2 className="animate-spin" />
            ) : process.running ? (
              <Square />
            ) : (
              <Play />
            )}
            {process.running ? "Stop" : "Start"}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            aria-expanded={logsOpen}
            onClick={() => setLogsOpen((open) => !open)}
          >
            {logsOpen ? <ChevronDown /> : <ChevronRight />}
            Logs
          </Button>
        </div>
      </div>
      {logsOpen ? (
        <ProcessLogs sandboxId={sandboxId} name={process.name} />
      ) : null}
    </div>
  );
}

/** Live output: the agent replays its buffered output on attach, then streams
 * over the read-only WebSocket (no refetching the whole log). */
function ProcessLogs({ sandboxId, name }: { sandboxId: string; name: string }) {
  return (
    <div className="border-t">
      <TerminalView
        wsPath={`/v1/sandboxes/${sandboxId}/attach/${name}?mode=ro`}
        readOnly
      />
    </div>
  );
}
