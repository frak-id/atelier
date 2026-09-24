import { ExternalLink, Lock } from "lucide-react";
import type { GitHubRepo } from "@/api/queries/github";
import { Badge } from "@/components/ui/badge";
import { formatRelativeTime } from "@/lib/formatters";
import { cn } from "@/lib/utils";

/**
 * Avatar + `owner/name` + a one-line meta row (language · last push ·
 * description). Shared by the Prebuilds tab rows, the spawn picker and the
 * quick-prebuild dialog, so a repo reads the same everywhere.
 */
export function RepoIdentity({
  repo,
  showLink = false,
  className,
}: {
  repo: GitHubRepo;
  /** Show an "open on GitHub" icon link next to the name. */
  showLink?: boolean;
  className?: string;
}) {
  const meta = [
    repo.language,
    repo.pushedAt ? `pushed ${formatRelativeTime(repo.pushedAt)}` : "empty",
  ].filter(Boolean);
  return (
    <div className={cn("flex min-w-0 items-center gap-3", className)}>
      <img
        src={repo.ownerAvatarUrl}
        alt=""
        loading="lazy"
        className="size-8 shrink-0 rounded-md bg-muted"
      />
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-1.5">
          <span className="truncate text-sm">
            <span className="text-muted-foreground">{repo.owner}/</span>
            <span className="font-medium">{repo.name}</span>
          </span>
          {repo.private ? (
            <Lock
              className="size-3.5 shrink-0 text-muted-foreground"
              aria-label="Private repository"
            />
          ) : null}
          {repo.archived ? <Badge variant="neutral">archived</Badge> : null}
          {repo.fork ? <Badge variant="neutral">fork</Badge> : null}
          {showLink ? (
            <a
              href={repo.htmlUrl}
              target="_blank"
              rel="noreferrer"
              className="shrink-0 rounded-sm text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 hover:text-foreground focus-visible:opacity-100 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
              aria-label={`Open ${repo.fullName} on GitHub`}
              title="Open on GitHub"
            >
              <ExternalLink className="size-3.5" />
            </a>
          ) : null}
        </div>
        <p className="truncate text-xs text-muted-foreground">
          {meta.join(" · ")}
          {repo.description ? (
            <span className="hidden sm:inline"> · {repo.description}</span>
          ) : null}
        </p>
      </div>
    </div>
  );
}
