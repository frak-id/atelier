import {
  type PrebuildRecord,
  prebuildJobTarget,
  prebuildRepoBranch,
  repoShortName,
} from "@atelier/spec";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { Layers, Loader2, Pencil, Plus, RefreshCw, Trash2 } from "lucide-react";
import { useState } from "react";
import {
  prebuildsListQuery,
  useDeletePrebuild,
  useRunPrebuild,
} from "@/api/queries/prebuilds";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { JobStatus } from "@/components/job-status";
import { RepoCatalogCard } from "@/components/repos/repo-catalog-card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { formatRelativeTime } from "@/lib/formatters";

export const Route = createFileRoute("/settings/prebuilds/")({
  component: PrebuildsPage,
});

/**
 * The repo tier beside the toolset tier (composed-prebuild-volumes.md):
 * content-addressed VolumeSnapshots, chained, node-local. The top card lists
 * the user's GitHub repos with one-click prebuild creation. The list below
 * is every stored snapshot, including ones made by hand or from the CLI.
 */
function PrebuildsPage() {
  return (
    <div className="space-y-4">
      <RepoCatalogCard />
      <PrebuildsList />
    </div>
  );
}

/** Title for a stored prebuild: `owner/name` (+ `#branch`) for repo
 * prebuilds, falling back to the ref for image-only or chained ones. */
function prebuildTitle(prebuild: PrebuildRecord): string {
  const { url, branch } = prebuildRepoBranch(prebuild);
  if (!url) return prebuild.ref;
  const name = repoShortName(url);
  return branch ? `${name}#${branch}` : name;
}

function PrebuildsList() {
  const {
    data: prebuilds,
    isPending,
    isError,
    error,
  } = useQuery(prebuildsListQuery());
  const runPrebuild = useRunPrebuild();
  const deletePrebuild = useDeletePrebuild();
  const [pendingDelete, setPendingDelete] = useState<string | undefined>();

  return (
    <Card>
      <CardHeader className="flex-row items-start justify-between gap-3 space-y-0">
        <div className="space-y-1.5">
          <CardTitle>Stored prebuilds</CardTitle>
          <CardDescription>
            Every workspace snapshot, reusable as a boot{" "}
            <code>source.snapshot</code>. Spawn from one on the{" "}
            <Link to="/spawn" className="underline">
              Spawn
            </Link>{" "}
            page.
          </CardDescription>
        </div>
        <Button asChild size="sm" variant="outline" className="shrink-0">
          <Link to="/settings/prebuilds/new">
            <Plus />
            New prebuild
          </Link>
        </Button>
      </CardHeader>
      <CardContent className="space-y-2">
        {isPending ? (
          <Skeleton className="h-12 w-full" />
        ) : isError ? (
          <p className="text-sm text-destructive">
            {error instanceof Error ? error.message : "Failed to load"}
          </p>
        ) : !prebuilds || prebuilds.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No prebuilds yet. Create one from a repository above.
          </p>
        ) : (
          prebuilds.map((prebuild: PrebuildRecord) => {
            const spec = prebuild.spec;
            return (
              <div
                key={prebuild.ref}
                className="flex flex-col gap-1 rounded-md border p-3"
              >
                <div className="flex flex-wrap items-center gap-2">
                  <Layers className="size-4 shrink-0 text-muted-foreground" />
                  <span className="truncate text-sm font-medium">
                    {prebuildTitle(prebuild)}
                  </span>
                  <JobStatus
                    kind="prebuild"
                    target={spec ? prebuildJobTarget(spec) : undefined}
                  />
                  {prebuild.parent ? (
                    <Badge variant="outline">chained</Badge>
                  ) : null}
                  {prebuild.inUse ? (
                    <Badge variant="secondary">in use</Badge>
                  ) : null}
                  <span className="text-xs text-muted-foreground">
                    {formatRelativeTime(prebuild.createdAt)}
                  </span>
                  <div className="ml-auto flex items-center gap-2">
                    {spec ? (
                      <>
                        <Button asChild variant="outline" size="sm">
                          <Link
                            to="/settings/prebuilds/$ref"
                            params={{ ref: prebuild.ref }}
                          >
                            <Pencil />
                            Edit
                          </Link>
                        </Button>
                        <Button
                          variant="outline"
                          size="sm"
                          disabled={runPrebuild.isPending}
                          onClick={() =>
                            runPrebuild.mutate({ spec, force: true })
                          }
                        >
                          {runPrebuild.isPending ? (
                            <Loader2 className="animate-spin" />
                          ) : (
                            <RefreshCw />
                          )}
                          Rebuild
                        </Button>
                      </>
                    ) : null}
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={prebuild.inUse || deletePrebuild.isPending}
                      title={
                        prebuild.inUse
                          ? "In use by a sandbox or a chained prebuild"
                          : "Delete this snapshot"
                      }
                      onClick={() => setPendingDelete(prebuild.ref)}
                    >
                      {deletePrebuild.isPending ? (
                        <Loader2 className="animate-spin" />
                      ) : (
                        <Trash2 />
                      )}
                      Delete
                    </Button>
                  </div>
                </div>
                <span className="truncate font-mono text-xs text-muted-foreground">
                  {prebuild.ref} · {prebuild.image}
                </span>
              </div>
            );
          })
        )}
      </CardContent>
      <ConfirmDialog
        open={pendingDelete !== undefined}
        onOpenChange={(next) => {
          if (!next) setPendingDelete(undefined);
        }}
        title="Delete prebuild?"
        description={
          <>
            This permanently deletes the snapshot{" "}
            <span className="font-mono">{pendingDelete}</span>. This cannot be
            undone.
          </>
        }
        onConfirm={() => {
          if (pendingDelete) deletePrebuild.mutate(pendingDelete);
        }}
      />
    </Card>
  );
}
