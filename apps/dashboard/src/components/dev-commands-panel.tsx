import { useQuery } from "@tanstack/react-query";
import {
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  ExternalLink,
  Loader2,
  Play,
  Square,
  Terminal,
  XCircle,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import {
  sandboxDevCommandLogsQuery,
  sandboxDevCommandsQuery,
  useStartDevCommand,
  useStopDevCommand,
} from "@/api/queries";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ScrollArea } from "@/components/ui/scroll-area";

export function DevCommandsPanel({ sandboxId }: { sandboxId: string }) {
  const { data, isLoading, refetch } = useQuery(
    sandboxDevCommandsQuery(sandboxId),
  );

  const commands = data?.commands ?? [];

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between">
        <CardTitle className="flex items-center gap-2">
          <Terminal className="h-5 w-5" />
          Dev Commands
        </CardTitle>
        <Button variant="outline" size="sm" onClick={() => refetch()}>
          Refresh
        </Button>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <div className="flex items-center gap-2 text-muted-foreground py-8 justify-center">
            <Loader2 className="h-4 w-4 animate-spin" />
            Loading commands...
          </div>
        ) : commands.length === 0 ? (
          <div className="text-center py-8 text-muted-foreground">
            <Terminal className="h-12 w-12 mx-auto mb-3 opacity-50" />
            <p>No dev commands configured</p>
            <p className="text-sm mt-1">
              Add dev commands to your workspace configuration
            </p>
          </div>
        ) : (
          <div className="space-y-4">
            {commands.map((cmd) => (
              <DevCommandItem
                key={cmd.name}
                sandboxId={sandboxId}
                command={cmd}
              />
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function DevCommandItem({
  sandboxId,
  command,
}: {
  sandboxId: string;
  command: {
    name: string;
    command: string;
    status: string;
    port?: number;
    pid?: number;
    exitCode?: number;
    devUrl?: string;
    defaultDevUrl?: string;
    extraDevUrls?: Array<{ alias: string; port: number; url: string }>;
  };
}) {
  const [expanded, setExpanded] = useState(false);
  const startMutation = useStartDevCommand(sandboxId);
  const stopMutation = useStopDevCommand(sandboxId);

  const isRunning = command.status === "running";
  const isPending = startMutation.isPending || stopMutation.isPending;

  const handleToggle = () => {
    if (isRunning) {
      stopMutation.mutate(command.name);
    } else {
      startMutation.mutate(command.name, {
        onSuccess: () => setExpanded(true),
      });
    }
  };

  return (
    <div className="border rounded-lg overflow-hidden">
      <div className="p-4 bg-muted/30 flex flex-col sm:flex-row sm:items-center gap-3 sm:justify-between">
        <div className="flex items-center gap-3 min-w-0">
          <Button
            variant="ghost"
            size="sm"
            className="h-6 w-6 p-0 shrink-0"
            onClick={() => setExpanded(!expanded)}
          >
            {expanded ? (
              <ChevronDown className="h-4 w-4" />
            ) : (
              <ChevronRight className="h-4 w-4" />
            )}
          </Button>
          <div className="min-w-0">
            <div className="font-medium flex items-center gap-2 flex-wrap">
              <span className="truncate">{command.name}</span>
              <StatusBadge
                status={command.status}
                exitCode={command.exitCode}
              />
            </div>
            <div className="text-xs text-muted-foreground font-mono mt-0.5 truncate">
              {command.command}
              {command.port && ` • Port ${command.port}`}
            </div>
          </div>
        </div>

        <div className="flex items-center gap-2 flex-wrap shrink-0 sm:justify-end">
          {command.extraDevUrls?.map((ep) =>
            isRunning ? (
              <Button key={ep.alias} variant="outline" size="sm" asChild>
                <a href={ep.url} target="_blank" rel="noopener noreferrer">
                  <ExternalLink className="h-3.5 w-3.5 mr-1.5" />
                  {ep.alias}
                </a>
              </Button>
            ) : null,
          )}

          {command.devUrl && isRunning && (
            <Button variant="outline" size="sm" asChild>
              <a
                href={command.devUrl}
                target="_blank"
                rel="noopener noreferrer"
              >
                <ExternalLink className="h-3.5 w-3.5 mr-1.5" />
                Open
              </a>
            </Button>
          )}

          <Button
            variant={isRunning ? "outline" : "default"}
            size="sm"
            onClick={handleToggle}
            disabled={isPending}
          >
            {isPending ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin mr-1.5" />
            ) : isRunning ? (
              <Square className="h-3.5 w-3.5 fill-current mr-1.5" />
            ) : (
              <Play className="h-3.5 w-3.5 fill-current mr-1.5" />
            )}
            {isRunning ? "Stop" : "Start"}
          </Button>
        </div>
      </div>

      {expanded && (
        <div className="border-t">
          <DevCommandLogs
            sandboxId={sandboxId}
            commandName={command.name}
            isRunning={isRunning}
          />
        </div>
      )}
    </div>
  );
}

function StatusBadge({
  status,
  exitCode,
}: {
  status: string;
  exitCode?: number;
}) {
  if (status === "running") {
    return (
      <Badge variant="success" className="gap-1">
        <CheckCircle2 className="h-3 w-3" />
        Running
      </Badge>
    );
  }
  if (
    status === "error" ||
    (status === "stopped" && exitCode && exitCode !== 0)
  ) {
    return (
      <Badge variant="destructive" className="gap-1">
        <XCircle className="h-3 w-3" />
        {exitCode ? `Exit ${exitCode}` : "Error"}
      </Badge>
    );
  }
  return <Badge variant="secondary">Stopped</Badge>;
}

function DevCommandLogs({
  sandboxId,
  commandName,
  isRunning,
}: {
  sandboxId: string;
  commandName: string;
  isRunning: boolean;
}) {
  const [logs, setLogs] = useState("");
  const [offset, setOffset] = useState(0);
  const scrollRef = useRef<HTMLDivElement>(null);
  const wasRunning = useRef(isRunning);

  useEffect(() => {
    if (isRunning && !wasRunning.current) {
      setLogs("");
      setOffset(0);
    }
    wasRunning.current = isRunning;
  }, [isRunning]);

  const { data } = useQuery({
    ...sandboxDevCommandLogsQuery(sandboxId, commandName, offset),
    refetchInterval: isRunning ? 2000 : false,
  });

  useEffect(() => {
    if (data) {
      if (data.content) {
        setLogs((prev) => prev + data.content);
      }
      if (data.nextOffset > offset) {
        setOffset(data.nextOffset);
      }
    }
  }, [data, offset]);

  useEffect(() => {
    if (scrollRef.current) {
      const scrollElement = scrollRef.current.querySelector(
        "[data-radix-scroll-area-viewport]",
      );
      if (scrollElement) {
        scrollElement.scrollTop = scrollElement.scrollHeight;
      }
    }
  });

  return (
    <div className="bg-black text-white font-mono text-xs p-0">
      <ScrollArea className="h-[300px] w-full" ref={scrollRef}>
        <div className="p-4 whitespace-pre-wrap">
          {logs || (
            <span className="text-gray-500 italic">No logs available</span>
          )}
        </div>
      </ScrollArea>
    </div>
  );
}
