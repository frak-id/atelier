import { useQuery } from "@tanstack/react-query";
import { Code2, ExternalLink, Trash2 } from "lucide-react";
import type { Sandbox } from "@/api/client";
import { opencodeSessionsQuery, useDeleteSandbox } from "@/api/queries";
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

  const displayName = workspaceName || sandbox.id;

  return (
    <div className="flex items-center justify-between py-2 px-3 rounded-lg hover:bg-muted/50 transition-colors">
      <div className="flex items-center gap-3 min-w-0">
        <div className="flex-1 min-w-0">
          <button
            type="button"
            onClick={() => onSandboxClick?.(sandbox.id)}
            className="font-semibold text-base hover:underline truncate block text-left"
          >
            {displayName}
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
