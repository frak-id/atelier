import { useQuery } from "@tanstack/react-query";
import { Github, LogOut, RefreshCw } from "lucide-react";
import {
  githubStatusQuery,
  useGitHubLogout,
  useGitHubReauthorize,
} from "@/api/queries";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";

export function GitHubStatus() {
  const { data: status, isLoading } = useQuery(githubStatusQuery);
  const logoutMutation = useGitHubLogout();
  const reauthorizeMutation = useGitHubReauthorize();

  if (isLoading) {
    return (
      <div className="flex items-center gap-2 px-3 py-2 text-sm text-muted-foreground">
        <Github className="h-4 w-4 animate-pulse" />
        <span className="hidden sm:inline">Loading...</span>
      </div>
    );
  }

  if (!status?.connected) {
    return (
      <Button
        variant="outline"
        size="sm"
        className="gap-2"
        onClick={() => {
          window.location.href = "/api/github/connect";
        }}
      >
        <Github className="h-4 w-4" />
        <span className="hidden sm:inline">Connect GitHub</span>
      </Button>
    );
  }

  return (
    <div className="flex items-center gap-2">
      <div className="flex items-center gap-2 px-2 py-1 rounded-md bg-accent/50">
        {status.user?.avatarUrl && (
          <img
            src={status.user.avatarUrl}
            alt={status.user.login}
            className="h-5 w-5 rounded-full"
          />
        )}
        <span className="text-sm font-medium hidden sm:inline">
          {status.user?.login}
        </span>
        <Github className="h-4 w-4 text-muted-foreground sm:hidden" />
      </div>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7"
            onClick={() => reauthorizeMutation.mutate()}
            disabled={reauthorizeMutation.isPending}
          >
            <RefreshCw className="h-3.5 w-3.5" />
            <span className="sr-only">Reauthorize GitHub</span>
          </Button>
        </TooltipTrigger>
        <TooltipContent>Reauthorize GitHub (grant org access)</TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7"
            onClick={() => logoutMutation.mutate()}
            disabled={logoutMutation.isPending}
          >
            <LogOut className="h-3.5 w-3.5" />
            <span className="sr-only">Disconnect GitHub</span>
          </Button>
        </TooltipTrigger>
        <TooltipContent>Disconnect GitHub</TooltipContent>
      </Tooltip>
    </div>
  );
}
