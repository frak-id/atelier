import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import {
  Check,
  Code2,
  ExternalLink,
  Loader2,
  Server,
  Terminal,
} from "lucide-react";
import { useCallback, useState } from "react";
import type { Sandbox } from "@/api/client";
import { sandboxListQuery } from "@/api/queries";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";

function useCopyToClipboard() {
  const [copiedKey, setCopiedKey] = useState<string | null>(null);

  const copy = useCallback((text: string, key: string) => {
    navigator.clipboard.writeText(text);
    setCopiedKey(key);
    setTimeout(() => setCopiedKey(null), 2000);
  }, []);

  return { copy, isCopied: (key: string) => copiedKey === key };
}

export function RunningSandboxesCard() {
  const { data: sandboxes, isLoading } = useQuery(sandboxListQuery());

  const runningSandboxes =
    sandboxes?.filter((s) => s.status === "running") ?? [];

  if (isLoading) {
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
          <SandboxRow key={sandbox.id} sandbox={sandbox} />
        ))}
      </CardContent>
    </Card>
  );
}

function SandboxRow({ sandbox }: { sandbox: Sandbox }) {
  const { copy, isCopied } = useCopyToClipboard();

  const sshCommand = sandbox.runtime.urls.ssh;

  return (
    <div className="flex items-center justify-between py-2 px-3 rounded-lg hover:bg-muted/50 transition-colors">
      <div className="flex items-center gap-3 min-w-0">
        <div className="flex-1 min-w-0">
          <Link
            to="/sandboxes/$id"
            params={{ id: sandbox.id }}
            className="font-mono text-sm hover:underline truncate block"
          >
            {sandbox.id}
          </Link>
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            {sandbox.workspaceId && (
              <span className="truncate">{sandbox.workspaceId}</span>
            )}
            <span>•</span>
            <span>{sandbox.runtime.ipAddress}</span>
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
              onClick={() => copy(sshCommand, `ssh-${sandbox.id}`)}
            >
              {isCopied(`ssh-${sandbox.id}`) ? (
                <Check className="h-4 w-4 text-green-500" />
              ) : (
                <Terminal className="h-4 w-4" />
              )}
            </Button>
          </TooltipTrigger>
          <TooltipContent>
            {isCopied(`ssh-${sandbox.id}`) ? "Copied!" : "Copy SSH command"}
          </TooltipContent>
        </Tooltip>
      </div>
    </div>
  );
}
