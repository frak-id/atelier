import { useQuery } from "@tanstack/react-query";
import { Loader2, Pin, PinOff, Trash2, Upload } from "lucide-react";
import { useState } from "react";
import {
  type ToolboxVersionWithArtifact,
  toolboxVersionsQuery,
  useDeleteToolboxVersion,
  usePublishToolboxVersion,
  useSetActiveToolboxVersion,
} from "@/api/queries/toolbox-versions";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { formatRelativeTime } from "@/lib/formatters";

/** Per-toolbox version history: label, description, provenance, pin/unpin,
 * delete, and a "recipe changed since pin" drift badge on the active row
 * (docs/toolbox-versions.md §3, §7). */
export function ToolboxVersionsPanel({ toolboxId }: { toolboxId: string }) {
  const { data, isPending, isError, error } = useQuery(
    toolboxVersionsQuery(toolboxId),
  );
  const setActive = useSetActiveToolboxVersion();
  const deleteVersion = useDeleteToolboxVersion();
  const [pendingDelete, setPendingDelete] = useState<
    ToolboxVersionWithArtifact | undefined
  >();
  const [pendingPublish, setPendingPublish] = useState<
    ToolboxVersionWithArtifact | undefined
  >();

  if (isPending) return <Skeleton className="mt-2 h-10 w-full" />;
  if (isError) {
    return (
      <p className="mt-2 text-sm text-destructive">
        {error instanceof Error ? error.message : "Failed to load versions"}
      </p>
    );
  }
  if (data.versions.length === 0) {
    return (
      <p className="mt-2 text-sm text-muted-foreground">
        No saved versions yet — capture one from a running sandbox.
      </p>
    );
  }

  return (
    <div className="mt-2 space-y-1.5">
      {data.versions.map((version) => {
        const isActive = version.id === data.activeVersionId;
        const drifted =
          isActive &&
          version.recipeFingerprint !== data.currentRecipeFingerprint;
        // Native binaries in a captured artifact are compiled against the
        // base image; if it moved since capture, the pinned toolset may not
        // match the current runtime (docs/toolbox-versions.md §5).
        const baseDrifted =
          isActive &&
          version.provenance.sourceImage !== undefined &&
          data.currentSourceImage !== undefined &&
          version.provenance.sourceImage !== data.currentSourceImage;
        return (
          <div
            key={version.id}
            className="flex flex-wrap items-center gap-2 rounded-md border p-2 text-sm"
          >
            <span className="font-mono">v{version.label}</span>
            <span className="truncate text-muted-foreground">
              {version.description}
            </span>
            <Badge variant="outline">{version.provenance.kind}</Badge>
            <span className="text-xs text-muted-foreground">
              {formatRelativeTime(version.createdAt)}
            </span>
            {isActive ? <Badge variant="success">active</Badge> : null}
            {drifted ? (
              <Badge variant="warning">recipe changed since pin</Badge>
            ) : null}
            {baseDrifted ? (
              <Badge variant="warning">base image changed since capture</Badge>
            ) : null}
            {version.artifact ? (
              <Badge
                variant={version.artifact.private ? "outline" : "secondary"}
              >
                {version.artifact.private ? "private" : "published"}
              </Badge>
            ) : null}
            <div className="ml-auto flex shrink-0 gap-1">
              {version.artifact?.private ? (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setPendingPublish(version)}
                >
                  <Upload />
                  Publish
                </Button>
              ) : null}
              {isActive ? (
                <Button
                  variant="outline"
                  size="sm"
                  disabled={setActive.isPending}
                  onClick={() =>
                    setActive.mutate({ toolboxId, versionId: null })
                  }
                >
                  <PinOff />
                  Unpin
                </Button>
              ) : (
                <Button
                  variant="outline"
                  size="sm"
                  disabled={setActive.isPending}
                  onClick={() =>
                    setActive.mutate({ toolboxId, versionId: version.id })
                  }
                >
                  <Pin />
                  Pin
                </Button>
              )}
              <Button
                variant="outline"
                size="icon"
                disabled={isActive || deleteVersion.isPending}
                aria-label={
                  isActive ? "Unpin before deleting" : "Delete version"
                }
                title={isActive ? "Unpin before deleting" : "Delete version"}
                onClick={() => setPendingDelete(version)}
              >
                <Trash2 />
              </Button>
            </div>
          </div>
        );
      })}
      <ConfirmDialog
        open={pendingDelete !== undefined}
        onOpenChange={(next) => {
          if (!next) setPendingDelete(undefined);
        }}
        title="Delete version?"
        description={
          <>
            This removes{" "}
            <span className="font-mono">v{pendingDelete?.label}</span> from the
            toolbox's history. This cannot be undone.
          </>
        }
        onConfirm={() => {
          if (pendingDelete)
            deleteVersion.mutate({ toolboxId, versionId: pendingDelete.id });
        }}
      />
      <PublishVersionDialog
        toolboxId={toolboxId}
        version={pendingPublish}
        onOpenChange={(next) => {
          if (!next) setPendingPublish(undefined);
        }}
      />
    </div>
  );
}

/** Confirms flipping a version's artifact from private to shareable: same
 * bytes, same digest, just a widened audience — so it can be pinned on an
 * org toolbox or moved into an org and replayed into every member's
 * sandbox. Lists the artifact's paths and warns to scrub credentials from
 * them first, since publishing can't be undone. */
function PublishVersionDialog({
  toolboxId,
  version,
  onOpenChange,
}: {
  toolboxId: string;
  version: ToolboxVersionWithArtifact | undefined;
  onOpenChange: (open: boolean) => void;
}) {
  const publish = usePublishToolboxVersion();

  return (
    <Dialog open={version !== undefined} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Publish v{version?.label}?</DialogTitle>
          <DialogDescription>
            Publishing marks this exact snapshot — same files, same digest — as
            shareable, so it can be pinned on an org toolbox or moved to an
            organization and replayed into every member's sandbox. This cannot
            be undone.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-2 py-2">
          <p className="text-sm text-muted-foreground">
            This artifact materializes these paths:
          </p>
          <ul className="space-y-1 font-mono text-sm">
            {version?.artifact?.paths.map((path) => (
              <li key={path}>{path}</li>
            ))}
          </ul>
          <p className="text-sm text-destructive">
            Make sure none of them contain personal credentials (API keys, auth
            tokens) before publishing.
          </p>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            disabled={publish.isPending}
            onClick={() => {
              if (version)
                publish.mutate(
                  { toolboxId, versionId: version.id },
                  { onSuccess: () => onOpenChange(false) },
                );
            }}
          >
            {publish.isPending ? <Loader2 className="animate-spin" /> : null}
            Publish
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
