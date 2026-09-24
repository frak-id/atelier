import { Link } from "@tanstack/react-router";
import { Pencil } from "lucide-react";
import { type FormEvent, useState } from "react";
import { useUpdateWorkspace, type Workspace } from "@/api/queries/launchpad";
import { PhaseBadge } from "@/components/launchpad/phase-badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { formatRelativeTime } from "@/lib/formatters";
import { LaunchpadIconView } from "@/lib/launchpad";

/**
 * A "jump back in" tile: the user's own words first (title + note), what it
 * was started from second, status third. The pencil opens a small rename
 * dialog without leaving the landing page.
 */
export function WorkspaceCard({ workspace }: { workspace: Workspace }) {
  const [renaming, setRenaming] = useState(false);

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
          className="relative z-10 size-8 opacity-60 group-hover:opacity-100"
          onClick={() => setRenaming(true)}
          aria-label="Rename"
          title="Rename or add a note"
        >
          <Pencil className="size-3.5" />
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
      {renaming ? (
        // Mounted only while open, so the fields seed from the latest data.
        <WorkspaceDetailsDialog
          workspace={workspace}
          onClose={() => setRenaming(false)}
        />
      ) : null}
    </div>
  );
}

/** Name + note editor for the landing card. */
function WorkspaceDetailsDialog({
  workspace,
  onClose,
}: {
  workspace: Workspace;
  onClose: () => void;
}) {
  const update = useUpdateWorkspace();
  const [title, setTitle] = useState(workspace.title);
  const [description, setDescription] = useState(workspace.description);

  function submit(event: FormEvent) {
    event.preventDefault();
    if (!title.trim()) return;
    update.mutate(
      { id: workspace.id, patch: { title, description } },
      { onSuccess: onClose },
    );
  }

  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : onClose())}>
      <DialogContent>
        <form onSubmit={submit} className="space-y-4">
          <DialogHeader>
            <DialogTitle>About this workspace</DialogTitle>
            <DialogDescription>
              A clear name and a short note make it easy to find later.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-1.5">
            <Label htmlFor={`ws-title-${workspace.id}`}>Name</Label>
            <Input
              id={`ws-title-${workspace.id}`}
              value={title}
              maxLength={120}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="e.g. Spring campaign hero"
              required
              autoFocus
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor={`ws-note-${workspace.id}`}>Note</Label>
            <textarea
              id={`ws-note-${workspace.id}`}
              value={description}
              maxLength={1000}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="What is this for? Who asked for it?"
              className="min-h-20 w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-xs focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
            />
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" loading={update.isPending}>
              Save
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
