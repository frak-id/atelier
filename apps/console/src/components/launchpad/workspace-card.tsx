import { Link } from "@tanstack/react-router";
import { Pencil } from "lucide-react";
import type { Workspace } from "@/api/queries/launchpad";
import { PhaseBadge } from "@/components/launchpad/phase-badge";
import { Button } from "@/components/ui/button";
import { formatRelativeTime } from "@/lib/formatters";
import { LaunchpadIconView } from "@/lib/launchpad";

/**
 * A "jump back in" tile: the user's own words first (title + note), what it
 * was started from second, status third. The pencil opens the workspace with
 * its name field ready to edit.
 */
export function WorkspaceCard({ workspace }: { workspace: Workspace }) {
  return (
    <div className="group relative flex flex-col gap-3 rounded-xl border bg-card p-4 shadow-xs transition-colors hover:border-foreground/25">
      <Link
        to="/launchpad/w/$workspaceId"
        params={{ workspaceId: workspace.id }}
        className="absolute inset-0 rounded-xl focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
        aria-label={`Open ${workspace.title}`}
      />
      <div className="flex items-start gap-3">
        <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted">
          <LaunchpadIconView icon={workspace.icon} className="size-4.5" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate font-medium">{workspace.title}</p>
          <p className="truncate text-xs text-muted-foreground">
            {workspace.starterTitle}
          </p>
        </div>
        <Button
          variant="ghost"
          size="icon"
          asChild
          className="relative z-10 size-8 opacity-60 group-hover:opacity-100"
        >
          {/* Same editor as the workspace page (it opens on the name). */}
          <Link
            to="/launchpad/w/$workspaceId"
            params={{ workspaceId: workspace.id }}
            search={{ edit: true }}
            aria-label={`Rename ${workspace.title}`}
            title="Rename or add a note"
          >
            <Pencil className="size-3.5" />
          </Link>
        </Button>
      </div>
      <p className="line-clamp-2 min-h-10 text-sm text-muted-foreground">
        {workspace.description || (
          <span className="italic opacity-70">No note yet</span>
        )}
      </p>
      <div className="flex items-center justify-between gap-2">
        <PhaseBadge phase={workspace.phase} />
        <span className="text-xs text-muted-foreground">
          {formatRelativeTime(workspace.updatedAt)}
        </span>
      </div>
    </div>
  );
}
