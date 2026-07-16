import type { PrebuildRecord } from "@atelier/spec";
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
 * content-addressed VolumeSnapshots, chained, node-local. No list endpoint
 * exists server-side (snapshots are an internal runtime concern; only build
 * is exposed) — this mirrors the CLI's `atelier prebuild <file>` exactly.
 */
function PrebuildsPage() {
  return (
    <div className="space-y-3">
      <div className="flex justify-end">
        <Button asChild size="sm">
          <Link to="/settings/prebuilds/new">
            <Plus />
            New prebuild
          </Link>
        </Button>
      </div>
      <PrebuildsList />
    </div>
  );
}

/** The queue `target` the server labels a prebuild job with (mirrors
 * `prebuildLabel` in v1.routes) — lets `<JobStatus>` match a running rebuild
 * of THIS snapshot back to its row. */
function prebuildJobTarget(prebuild: PrebuildRecord): string | undefined {
  const source = prebuild.spec?.source;
  return (
    prebuild.spec?.repos?.[0]?.url ??
    (source && "image" in source ? source.image : source?.snapshot)
  );
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
      <CardHeader>
        <CardTitle>Prebuilds</CardTitle>
        <CardDescription>
          Stored workspace snapshots, reusable as a boot{" "}
          <code>source.snapshot</code>. One-tap spawn from the{" "}
          <a href="/spawn" className="underline">
            Spawn
          </a>{" "}
          page.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-2">
        {isPending ? (
          <Skeleton className="h-12 w-full" />
        ) : isError ? (
          <p className="text-sm text-destructive">
            {error instanceof Error ? error.message : "Failed to load"}
          </p>
        ) : !prebuilds || prebuilds.length === 0 ? (
          <p className="text-sm text-muted-foreground">No prebuilds yet.</p>
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
                  <span className="truncate font-mono text-sm">
                    {prebuild.ref}
                  </span>
                  <JobStatus
                    kind="prebuild"
                    target={prebuildJobTarget(prebuild)}
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
                  {prebuild.image}
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
