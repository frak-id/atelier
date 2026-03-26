import { useQuery } from "@tanstack/react-query";
import { Github } from "lucide-react";
import { githubStatusQuery } from "@/api/queries";

export function GitHubStatus() {
  const { data: status, isLoading } = useQuery(githubStatusQuery);

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
      <div className="flex items-center gap-2 px-2 py-1 rounded-md text-sm text-muted-foreground">
        <Github className="h-4 w-4" />
        <span className="hidden sm:inline">GitHub not connected</span>
      </div>
    );
  }

  return (
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
  );
}
