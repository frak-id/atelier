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
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import {
  deriveToolStatus,
  sandboxToolsQuery,
  serviceLogsQuery,
  useSandboxServices,
  useStartTool,
  useStopTool,
} from "@/api/queries";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ScrollArea } from "@/components/ui/scroll-area";

const DEV_SLUG = "dev";

export function DevCommandsPanel({ sandboxId }: { sandboxId: string }) {
  const { data: tools, isLoading } = useQuery(sandboxToolsQuery(sandboxId));
  const { data: servicesData } = useSandboxServices(sandboxId);
  const devTool = tools?.find((t) => t.slug === DEV_SLUG);

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between">
        <CardTitle className="flex items-center gap-2">
          <Terminal className="h-5 w-5" />
          Dev Server
        </CardTitle>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <div className="flex items-center gap-2 text-muted-foreground py-8 justify-center">
            <Loader2 className="h-4 w-4 animate-spin" />
            Loading...
          </div>
        ) : !devTool ? (
          <div className="text-center py-8 text-muted-foreground">
            <Terminal className="h-12 w-12 mx-auto mb-3 opacity-50" />
            <p>No dev server configured</p>
            <p className="text-sm mt-1">
              Set a dev command in your workspace configuration
            </p>
          </div>
        ) : (
          <DevServerItem
            sandboxId={sandboxId}
            url={devTool.url}
            status={deriveToolStatus(servicesData, devTool)}
          />
        )}
      </CardContent>
    </Card>
  );
}

function DevServerItem({
  sandboxId,
  url,
  status,
}: {
  sandboxId: string;
  url?: string;
  status: string;
}) {
  const [expanded, setExpanded] = useState(false);
  const startMutation = useStartTool(sandboxId);
  const stopMutation = useStopTool(sandboxId);

  const isRunning = status === "running";
  const isPending = startMutation.isPending || stopMutation.isPending;

  const handleToggle = () => {
    if (isRunning) {
      stopMutation.mutate(DEV_SLUG);
    } else {
      startMutation.mutate(DEV_SLUG, { onSuccess: () => setExpanded(true) });
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
          <div className="font-medium flex items-center gap-2 flex-wrap">
            <span className="truncate">Dev Server</span>
            {isRunning ? (
              <Badge variant="success" className="gap-1">
                <CheckCircle2 className="h-3 w-3" />
                Running
              </Badge>
            ) : (
              <Badge variant="secondary">Stopped</Badge>
            )}
          </div>
        </div>

        <div className="flex items-center gap-2 flex-wrap shrink-0 sm:justify-end">
          {url && isRunning && (
            <Button variant="outline" size="sm" asChild>
              <a href={url} target="_blank" rel="noopener noreferrer">
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
          <DevServerLogs sandboxId={sandboxId} isRunning={isRunning} />
        </div>
      )}
    </div>
  );
}

function DevServerLogs({
  sandboxId,
  isRunning,
}: {
  sandboxId: string;
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
    ...serviceLogsQuery(sandboxId, DEV_SLUG, offset),
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
