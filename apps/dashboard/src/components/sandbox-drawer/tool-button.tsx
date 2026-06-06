import { Link } from "@tanstack/react-router";
import { Loader2 } from "lucide-react";
import { type ToolStatus, useStopTool } from "@/api/queries";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { toolUiFor } from "@/lib/tools";

interface ToolButtonTool {
  slug: string;
  name: string;
  start: "boot" | "lazy";
  exposed: boolean;
}

function isStoppable(tool: ToolButtonTool, status: ToolStatus): boolean {
  return tool.start === "lazy" && tool.exposed && status === "running";
}

export function ToolButton({
  sandboxId,
  tool,
  status,
}: {
  sandboxId: string;
  tool: ToolButtonTool;
  status: ToolStatus;
}) {
  const ui = toolUiFor(tool.slug);
  const Icon = ui.icon;
  const stopTool = useStopTool(sandboxId);

  const launch = (
    <Button variant="outline" size="sm" asChild>
      <Link
        to="/sandboxes/$id"
        params={{ id: sandboxId }}
        search={{ tab1: tool.slug }}
        target="_blank"
      >
        <Icon className="h-4 w-4 mr-2" />
        {tool.name}
      </Link>
    </Button>
  );

  if (!isStoppable(tool, status)) return launch;

  return (
    <div className="flex items-center gap-1">
      {launch}
      <Button
        variant="ghost"
        size="sm"
        onClick={() => stopTool.mutate(tool.slug)}
        disabled={stopTool.isPending}
        className="h-8 px-2 text-muted-foreground hover:text-destructive"
      >
        {stopTool.isPending ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
        ) : (
          <span className="text-xs">Stop</span>
        )}
      </Button>
    </div>
  );
}

export function ToolIconButton({
  sandboxId,
  tool,
  status,
}: {
  sandboxId: string;
  tool: ToolButtonTool;
  status: ToolStatus;
}) {
  const ui = toolUiFor(tool.slug);
  const Icon = ui.icon;
  const running = isStoppable(tool, status);

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="h-8 w-8 text-muted-foreground hover:text-foreground"
          asChild
        >
          <Link
            to="/sandboxes/$id"
            params={{ id: sandboxId }}
            search={{ tab1: tool.slug }}
            target="_blank"
          >
            <Icon className="h-4 w-4" />
            {running && (
              <span className="absolute top-1 right-1 h-1.5 w-1.5 rounded-full bg-green-500" />
            )}
          </Link>
        </Button>
      </TooltipTrigger>
      <TooltipContent>{tool.name}</TooltipContent>
    </Tooltip>
  );
}
