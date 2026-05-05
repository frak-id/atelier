import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Bot, Monitor, Trash2 } from "lucide-react";
import type { Sandbox } from "@/api/client";
import { opencodeSessionsQuery, useDeleteSandbox } from "@/api/queries";
import { IntegrationSourceBadge } from "@/components/integration-source-badge";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";

type SandboxRowProps = {
  sandbox: Sandbox;
  workspaceName?: string;
  showDelete?: boolean;
  onSandboxClick?: (sandboxId: string) => void;
};

export function SandboxRow({
  sandbox,
  workspaceName,
  showDelete = true,
  onSandboxClick,
}: SandboxRowProps) {
  const deleteMutation = useDeleteSandbox();

  const { data: sessions } = useQuery({
    ...opencodeSessionsQuery(sandbox.runtime.urls.opencode),
    enabled: sandbox.status === "running",
  });
  const sessionCount = sessions?.length ?? 0;

  const handleDelete = () => {
    if (confirm(`Delete sandbox ${sandbox.id}?`)) {
      deleteMutation.mutate(sandbox.id);
    }
  };

  const displayName = sandbox.name || workspaceName || sandbox.id;

  return (
    <div className="flex items-center justify-between py-2 px-3 rounded-lg hover:bg-muted/50 transition-colors">
      <div className="flex items-center gap-3 min-w-0">
        <div className="flex-1 min-w-0">
          <button
            type="button"
            onClick={() => onSandboxClick?.(sandbox.id)}
            className="font-semibold text-base hover:underline truncate text-left flex items-center gap-2"
          >
            <span className="truncate">{displayName}</span>
            <IntegrationSourceBadge integration={sandbox.origin} />
          </button>
          <div className="flex items-center gap-2 text-xs text-muted-foreground mt-0.5">
            <span className="font-mono">{sandbox.id}</span>
            <span>•</span>
            <Badge
              variant={
                sandbox.status === "running"
                  ? "success"
                  : sandbox.status === "creating"
                    ? "warning"
                    : "secondary"
              }
              className="text-xs py-0"
            >
              {sandbox.status}
            </Badge>
            {sandbox.status === "running" && (
              <>
                <span>•</span>
                <span>
                  {sessionCount} session{sessionCount !== 1 ? "s" : ""}
                </span>
              </>
            )}
          </div>
        </div>
      </div>

      <div className="flex items-center gap-1">
        {sandbox.status === "running" && (
          <>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button variant="ghost" size="icon" className="h-8 w-8" asChild>
                  <Link
                    to="/sandboxes/$id"
                    params={{ id: sandbox.id }}
                    search={{ tab1: "vscode" }}
                    target="_blank"
                  >
                    <Monitor className="h-4 w-4" />
                  </Link>
                </Button>
              </TooltipTrigger>
              <TooltipContent>Open VSCode</TooltipContent>
            </Tooltip>

            <Tooltip>
              <TooltipTrigger asChild>
                <Button variant="ghost" size="icon" className="h-8 w-8" asChild>
                  <Link
                    to="/sandboxes/$id"
                    params={{ id: sandbox.id }}
                    search={{ tab1: "opencode" }}
                    target="_blank"
                  >
                    <Bot className="h-4 w-4" />
                  </Link>
                </Button>
              </TooltipTrigger>
              <TooltipContent>Open OpenCode</TooltipContent>
            </Tooltip>
          </>
        )}

        {showDelete && (
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
        )}
      </div>
    </div>
  );
}
