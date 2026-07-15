import type {
  ToolboxConfig,
  ToolboxVersion,
  ToolsetEntry,
} from "@atelier/spec";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import {
  ChevronDown,
  ChevronRight,
  Loader2,
  Package,
  Pencil,
  Pin,
  PinOff,
  Plus,
  Trash2,
  Wrench,
} from "lucide-react";
import { useState } from "react";
import { organizationsListQuery } from "@/api/queries/organizations";
import {
  toolboxVersionsQuery,
  useDeleteToolboxVersion,
  useSetActiveToolboxVersion,
} from "@/api/queries/toolbox-versions";
import { toolboxesListQuery, useDeleteToolbox } from "@/api/queries/toolboxes";
import { toolsetsListQuery } from "@/api/queries/toolsets";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { ToolsetsSection } from "@/components/toolsets-section";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { formatRelativeTime } from "@/lib/formatters";

export const Route = createFileRoute("/settings/toolboxes/")({
  component: ToolboxesPage,
});

/** The artifact name a toolbox compiles into at spawn (`resolveToolboxRefs`). */
function toolboxArtifactName(toolbox: ToolboxConfig): string {
  return `tb/${toolbox.ownerType}/${toolbox.ownerId}/${toolbox.slug}`;
}

/**
 * Scope selector over the caller's toolbox owners: "My Toolboxes" (identity-
 * scoped, `user`) plus each org the caller belongs to (`org:<id>`). The value
 * is the `?owner=` string passed straight to the API.
 */
function ScopeSelect({
  value,
  onChange,
}: {
  value: string;
  onChange: (owner: string) => void;
}) {
  const { data: orgs, isError } = useQuery(organizationsListQuery());
  return (
    <div className="space-y-1">
      <Label htmlFor="toolbox-scope">Scope</Label>
      <select
        id="toolbox-scope"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm shadow-sm focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-ring"
      >
        <option value="user">My Toolboxes</option>
        {orgs?.map((org) => (
          <option key={org.id} value={`org:${org.id}`}>
            {org.name} (org)
          </option>
        ))}
      </select>
      {isError ? (
        <p className="text-xs text-destructive">
          Failed to load organizations.
        </p>
      ) : null}
    </div>
  );
}

function ToolboxesPage() {
  const [owner, setOwner] = useState("user");
  const {
    data: toolboxes,
    isPending,
    isError,
    error,
  } = useQuery(toolboxesListQuery(owner));
  const { data: toolsets } = useQuery(toolsetsListQuery());
  const artifactByName = new Map(
    (toolsets ?? []).map((toolset) => [toolset.name, toolset] as const),
  );

  return (
    <div className="space-y-6">
      <div className="space-y-3">
        <p className="text-sm text-muted-foreground">
          Toolboxes are owner-scoped recipes (<code>build[]</code> +{" "}
          <code>paths[]</code>) that, when enabled, are automatically compiled
          into a <strong>toolset</strong> (the resulting build artifact) and
          injected into every spawn for that user or org.
        </p>
        <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
          <div className="w-full sm:max-w-xs">
            <ScopeSelect value={owner} onChange={setOwner} />
          </div>
          <Button size="sm" asChild>
            <Link to="/settings/toolboxes/new" search={{ owner }}>
              <Plus />
              Add toolbox
            </Link>
          </Button>
        </div>
        {isPending ? (
          <Skeleton className="h-16 w-full" />
        ) : isError ? (
          <p className="text-sm text-destructive">
            {error instanceof Error ? error.message : "Failed to load"}
          </p>
        ) : toolboxes.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No toolboxes in this scope.
          </p>
        ) : (
          <div className="space-y-2">
            {toolboxes.map((toolbox) => (
              <ToolboxRow
                key={toolbox.id}
                toolbox={toolbox}
                owner={owner}
                artifact={artifactByName.get(toolboxArtifactName(toolbox))}
              />
            ))}
          </div>
        )}
      </div>
      <ToolsetsSection filter={(toolset) => !toolset.name.startsWith("tb/")} />
    </div>
  );
}

function ToolboxRow({
  toolbox,
  owner,
  artifact,
}: {
  toolbox: ToolboxConfig;
  owner: string;
  artifact: ToolsetEntry | undefined;
}) {
  const deleteToolbox = useDeleteToolbox();
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [versionsOpen, setVersionsOpen] = useState(false);

  return (
    <Card>
      <CardContent className="flex flex-col gap-2 p-3">
        <div className="flex items-center justify-between gap-2">
          <div className="flex min-w-0 items-center gap-2">
            <Wrench className="size-4 shrink-0 text-muted-foreground" />
            <span className="truncate font-mono text-sm">{toolbox.slug}</span>
            <span className="truncate text-sm text-muted-foreground">
              {toolbox.description}
            </span>
            <Badge variant={toolbox.autoInject ? "success" : "secondary"}>
              {toolbox.autoInject ? "auto-inject" : "manual"}
            </Badge>
            {toolbox.harness ? (
              <Badge variant="outline">harness: {toolbox.harness}</Badge>
            ) : null}
            {toolbox.processes && toolbox.processes.length > 0 ? (
              <Badge variant="outline">
                runs: {toolbox.processes.map((p) => p.name).join(", ")}
              </Badge>
            ) : null}
          </div>
          <div className="flex shrink-0 gap-1">
            <Button
              variant="outline"
              size="icon"
              asChild
              aria-label="Edit toolbox"
            >
              <Link
                to="/settings/toolboxes/$id"
                params={{ id: toolbox.id }}
                search={{ owner }}
              >
                <Pencil />
              </Link>
            </Button>
            <Button
              variant="outline"
              size="icon"
              disabled={deleteToolbox.isPending}
              onClick={() => setConfirmOpen(true)}
              aria-label="Delete toolbox"
            >
              {deleteToolbox.isPending ? (
                <Loader2 className="animate-spin" />
              ) : (
                <Trash2 />
              )}
            </Button>
          </div>
        </div>
        <div className="flex min-w-0 items-center gap-2 border-t pt-2 text-xs text-muted-foreground">
          <Package className="size-3.5 shrink-0" />
          {artifact ? (
            <>
              <span className="truncate font-mono">{artifact.ref}</span>
              <span className="shrink-0">
                built {formatRelativeTime(artifact.createdAt)}
              </span>
            </>
          ) : (
            <span>Artifact not built yet — compiled on next spawn.</span>
          )}
        </div>
        <div className="border-t pt-2">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setVersionsOpen((open) => !open)}
          >
            {versionsOpen ? <ChevronDown /> : <ChevronRight />}
            Versions
          </Button>
          {/* Mounted only while open — mirrors ProcessLogs' mount-gate so N
           * toolbox rows don't fire N version queries on page load. */}
          {versionsOpen ? (
            <ToolboxVersionsPanel toolboxId={toolbox.id} />
          ) : null}
        </div>
      </CardContent>
      <ConfirmDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        title="Delete toolbox?"
        description={
          <>
            New spawns in this scope will no longer include{" "}
            <span className="font-mono">{toolbox.slug}</span>. This cannot be
            undone.
          </>
        }
        onConfirm={() => deleteToolbox.mutate(toolbox.id)}
      />
    </Card>
  );
}

/** Per-toolbox version history: label, description, provenance, pin/unpin,
 * delete, and a "recipe changed since pin" drift badge on the active row
 * (docs/toolbox-versions.md §3, §7). */
function ToolboxVersionsPanel({ toolboxId }: { toolboxId: string }) {
  const { data, isPending, isError, error } = useQuery(
    toolboxVersionsQuery(toolboxId),
  );
  const setActive = useSetActiveToolboxVersion();
  const deleteVersion = useDeleteToolboxVersion();
  const [pendingDelete, setPendingDelete] = useState<
    ToolboxVersion | undefined
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
            <div className="ml-auto flex shrink-0 gap-1">
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
    </div>
  );
}
