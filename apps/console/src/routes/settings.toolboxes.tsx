import type {
  ToolboxConfig,
  ToolboxVersion,
  ToolsetEntry,
} from "@atelier/spec";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
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
import { type FormEvent, useState } from "react";
import { organizationsListQuery } from "@/api/queries/organizations";
import {
  toolboxVersionsQuery,
  useDeleteToolboxVersion,
  useSetActiveToolboxVersion,
} from "@/api/queries/toolbox-versions";
import {
  toolboxesListQuery,
  useCreateToolbox,
  useDeleteToolbox,
  useUpdateToolbox,
} from "@/api/queries/toolboxes";
import { toolsetsListQuery } from "@/api/queries/toolsets";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { ToolsetsSection } from "@/components/toolsets-section";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { formatRelativeTime } from "@/lib/formatters";

export const Route = createFileRoute("/settings/toolboxes")({
  component: ToolboxesPage,
});

/** The artifact name a toolbox compiles into at spawn (`resolveToolboxRefs`). */
function toolboxArtifactName(toolbox: ToolboxConfig): string {
  return `tb/${toolbox.ownerType}/${toolbox.ownerId}/${toolbox.slug}`;
}

function linesToArray(text: string): string[] {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

function arrayToLines(values: string[]): string {
  return values.join("\n");
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
  const [createOpen, setCreateOpen] = useState(false);
  const [editing, setEditing] = useState<ToolboxConfig | undefined>();
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
          <Button size="sm" onClick={() => setCreateOpen(true)}>
            <Plus />
            Add toolbox
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
                artifact={artifactByName.get(toolboxArtifactName(toolbox))}
                onEdit={() => setEditing(toolbox)}
              />
            ))}
          </div>
        )}
      </div>
      <ToolsetsSection filter={(toolset) => !toolset.name.startsWith("tb/")} />
      <ToolboxDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        owner={owner}
      />
      <ToolboxDialog
        key={editing?.id ?? "none"}
        open={editing !== undefined}
        onOpenChange={(next) => {
          if (!next) setEditing(undefined);
        }}
        owner={owner}
        toolbox={editing}
      />
    </div>
  );
}

function ToolboxRow({
  toolbox,
  artifact,
  onEdit,
}: {
  toolbox: ToolboxConfig;
  artifact: ToolsetEntry | undefined;
  onEdit: () => void;
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
              onClick={onEdit}
              aria-label="Edit toolbox"
            >
              <Pencil />
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

function ToolboxDialog({
  open,
  onOpenChange,
  owner,
  toolbox,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  owner: string;
  toolbox?: ToolboxConfig;
}) {
  const createToolbox = useCreateToolbox();
  const updateToolbox = useUpdateToolbox();
  const isEditing = toolbox !== undefined;

  const [slug, setSlug] = useState(toolbox?.slug ?? "");
  const [description, setDescription] = useState(toolbox?.description ?? "");
  const [build, setBuild] = useState(arrayToLines(toolbox?.build ?? []));
  const [paths, setPaths] = useState(arrayToLines(toolbox?.paths ?? []));
  const [autoInject, setAutoInject] = useState(toolbox?.autoInject ?? false);
  const [harness, setHarness] = useState(toolbox?.harness ?? "");
  const [processesText, setProcessesText] = useState(
    toolbox?.processes ? JSON.stringify(toolbox.processes, null, 2) : "",
  );
  const [portsText, setPortsText] = useState(
    toolbox?.ports ? JSON.stringify(toolbox.ports, null, 2) : "",
  );
  const [jsonError, setJsonError] = useState<string | undefined>();
  const [sourceImage, setSourceImage] = useState(
    toolbox?.source && "image" in toolbox.source ? toolbox.source.image : "",
  );

  function reset() {
    setSlug(toolbox?.slug ?? "");
    setDescription(toolbox?.description ?? "");
    setBuild(arrayToLines(toolbox?.build ?? []));
    setPaths(arrayToLines(toolbox?.paths ?? []));
    setAutoInject(toolbox?.autoInject ?? false);
    setHarness(toolbox?.harness ?? "");
    setProcessesText(
      toolbox?.processes ? JSON.stringify(toolbox.processes, null, 2) : "",
    );
    setPortsText(toolbox?.ports ? JSON.stringify(toolbox.ports, null, 2) : "");
    setJsonError(undefined);
    setSourceImage(
      toolbox?.source && "image" in toolbox.source ? toolbox.source.image : "",
    );
  }

  function parseJsonArray(text: string, label: string) {
    const trimmed = text.trim();
    if (!trimmed) return undefined;
    let value: unknown;
    try {
      value = JSON.parse(trimmed);
    } catch {
      throw new Error(`${label} is not valid JSON`);
    }
    if (!Array.isArray(value)) throw new Error(`${label} must be a JSON array`);
    return value;
  }

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    const buildSteps = linesToArray(build);
    const pathList = linesToArray(paths);
    if (!description) return;

    let processes: unknown;
    let ports: unknown;
    try {
      processes = parseJsonArray(processesText, "Processes");
      ports = parseJsonArray(portsText, "Ports");
    } catch (err) {
      setJsonError(err instanceof Error ? err.message : "Invalid JSON");
      return;
    }
    setJsonError(undefined);
    const source = sourceImage ? { image: sourceImage } : undefined;

    const harnessValue = harness.trim();
    if (isEditing && toolbox) {
      updateToolbox.mutate(
        {
          id: toolbox.id,
          patch: {
            description,
            build: buildSteps,
            paths: pathList,
            autoInject,
            source,
            harness: harnessValue ? harnessValue : null,
            // biome-ignore lint/suspicious/noExplicitAny: validated JSON passthrough
            processes: (processes ?? []) as any,
            // biome-ignore lint/suspicious/noExplicitAny: validated JSON passthrough
            ports: (ports ?? []) as any,
          },
        },
        { onSuccess: () => onOpenChange(false) },
      );
      return;
    }

    if (!slug) return;
    createToolbox.mutate(
      {
        owner,
        input: {
          slug,
          description,
          build: buildSteps,
          paths: pathList,
          autoInject,
          source,
          harness: harnessValue || undefined,
          // biome-ignore lint/suspicious/noExplicitAny: validated JSON passthrough
          processes: processes as any,
          // biome-ignore lint/suspicious/noExplicitAny: validated JSON passthrough
          ports: ports as any,
        },
      },
      {
        onSuccess: () => {
          reset();
          onOpenChange(false);
        },
      },
    );
  }

  const isPending = createToolbox.isPending || updateToolbox.isPending;

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) reset();
        onOpenChange(next);
      }}
    >
      <DialogContent className="max-w-xl">
        <form onSubmit={handleSubmit}>
          <DialogHeader>
            <DialogTitle>
              {isEditing ? "Edit toolbox" : "Add toolbox"}
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-3 py-2">
            <div className="space-y-1">
              <Label htmlFor="toolbox-slug">Slug</Label>
              <Input
                id="toolbox-slug"
                value={slug}
                onChange={(e) => setSlug(e.target.value)}
                required
                disabled={isEditing}
                autoFocus={!isEditing}
                placeholder="org-toolbox"
                className="font-mono"
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="toolbox-description">Description</Label>
              <Input
                id="toolbox-description"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                required
                placeholder="opencode + code-server (default)"
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="toolbox-build">
                Build steps (one per line, optional)
              </Label>
              <textarea
                id="toolbox-build"
                value={build}
                onChange={(e) => setBuild(e.target.value)}
                spellCheck={false}
                placeholder="curl -fsSL https://example.com/tool -o ~/.local/bin/tool"
                className="min-h-24 w-full rounded-md border bg-muted/30 p-2 font-mono text-xs"
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="toolbox-paths">
                Paths (one per line, optional)
              </Label>
              <textarea
                id="toolbox-paths"
                value={paths}
                onChange={(e) => setPaths(e.target.value)}
                spellCheck={false}
                placeholder="~/.local/bin/tool"
                className="min-h-16 w-full rounded-md border bg-muted/30 p-2 font-mono text-xs"
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="toolbox-harness">Harness (optional)</Label>
              <Input
                id="toolbox-harness"
                value={harness}
                onChange={(e) => setHarness(e.target.value)}
                placeholder="opencode / pi"
                className="font-mono"
              />
              <p className="text-xs text-muted-foreground">
                If set, spawns using this toolbox get this harness unless the
                spec declares its own.
              </p>
            </div>
            <div className="space-y-1">
              <Label htmlFor="toolbox-processes">
                Processes (JSON array, optional)
              </Label>
              <textarea
                id="toolbox-processes"
                value={processesText}
                onChange={(e) => setProcessesText(e.target.value)}
                spellCheck={false}
                placeholder={
                  '[{"name":"vscode","command":"code-server ...","lazy":true,"readiness":{"port":8080}}]'
                }
                className="min-h-24 w-full rounded-md border bg-muted/30 p-2 font-mono text-xs"
              />
              <p className="text-xs text-muted-foreground">
                The tool's running surface. Mark long-running ones{" "}
                <code>"lazy": true</code> so they start on demand from the
                sandbox view.
              </p>
            </div>
            <div className="space-y-1">
              <Label htmlFor="toolbox-ports">
                Ports (JSON array, optional)
              </Label>
              <textarea
                id="toolbox-ports"
                value={portsText}
                onChange={(e) => setPortsText(e.target.value)}
                spellCheck={false}
                placeholder={
                  '[{"name":"vscode","port":8080,"public":true,"auth":"forward"}]'
                }
                className="min-h-16 w-full rounded-md border bg-muted/30 p-2 font-mono text-xs"
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="toolbox-source">Source image (optional)</Label>
              <Input
                id="toolbox-source"
                value={sourceImage}
                onChange={(e) => setSourceImage(e.target.value)}
                placeholder="dev-base-v2"
                className="font-mono"
              />
            </div>
            {jsonError ? (
              <p className="text-sm text-destructive">{jsonError}</p>
            ) : null}
            <label
              htmlFor="toolbox-autoinject"
              className="flex items-center gap-2 text-sm"
            >
              <Checkbox
                id="toolbox-autoinject"
                checked={autoInject}
                onChange={(e) => setAutoInject(e.target.checked)}
              />
              Auto-inject into every spawn
            </label>
            <p className="-mt-2 text-xs text-muted-foreground">
              Off = the toolbox is still fully usable, just opt-in (select it
              per spawn). On = applied to all of this owner's sandboxes.
            </p>
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={isPending}>
              {isPending ? <Loader2 className="animate-spin" /> : null}
              Save
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
