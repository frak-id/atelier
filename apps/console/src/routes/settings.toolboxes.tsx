import type { ToolboxConfig } from "@atelier/spec";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { Loader2, Pencil, Plus, Trash2, Wrench } from "lucide-react";
import { type FormEvent, useState } from "react";
import { organizationsListQuery } from "@/api/queries/organizations";
import {
  toolboxesListQuery,
  useCreateToolbox,
  useDeleteToolbox,
  useUpdateToolbox,
} from "@/api/queries/toolboxes";
import { ConfirmDialog } from "@/components/confirm-dialog";
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

export const Route = createFileRoute("/settings/toolboxes")({
  component: ToolboxesPage,
});

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

  return (
    <div className="space-y-3">
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
              onEdit={() => setEditing(toolbox)}
            />
          ))}
        </div>
      )}
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
  onEdit,
}: {
  toolbox: ToolboxConfig;
  onEdit: () => void;
}) {
  const deleteToolbox = useDeleteToolbox();
  const [confirmOpen, setConfirmOpen] = useState(false);

  return (
    <Card>
      <CardContent className="flex items-center justify-between gap-2 p-3">
        <div className="flex min-w-0 items-center gap-2">
          <Wrench className="size-4 shrink-0 text-muted-foreground" />
          <span className="truncate font-mono text-sm">{toolbox.slug}</span>
          <span className="truncate text-sm text-muted-foreground">
            {toolbox.description}
          </span>
          <Badge variant={toolbox.enabled ? "success" : "secondary"}>
            {toolbox.enabled ? "enabled" : "disabled"}
          </Badge>
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
  const [enabled, setEnabled] = useState(toolbox?.enabled ?? true);
  const [sourceImage, setSourceImage] = useState(
    toolbox?.source && "image" in toolbox.source ? toolbox.source.image : "",
  );

  function reset() {
    setSlug(toolbox?.slug ?? "");
    setDescription(toolbox?.description ?? "");
    setBuild(arrayToLines(toolbox?.build ?? []));
    setPaths(arrayToLines(toolbox?.paths ?? []));
    setEnabled(toolbox?.enabled ?? true);
    setSourceImage(
      toolbox?.source && "image" in toolbox.source ? toolbox.source.image : "",
    );
  }

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    const buildSteps = linesToArray(build);
    const pathList = linesToArray(paths);
    if (!description || buildSteps.length === 0 || pathList.length === 0)
      return;
    const source = sourceImage ? { image: sourceImage } : undefined;

    if (isEditing && toolbox) {
      updateToolbox.mutate(
        {
          id: toolbox.id,
          patch: {
            description,
            build: buildSteps,
            paths: pathList,
            enabled,
            source,
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
          enabled,
          source,
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
              <Label htmlFor="toolbox-build">Build steps (one per line)</Label>
              <textarea
                id="toolbox-build"
                value={build}
                onChange={(e) => setBuild(e.target.value)}
                spellCheck={false}
                required
                placeholder="curl -fsSL https://example.com/tool -o ~/.local/bin/tool"
                className="min-h-24 w-full rounded-md border bg-muted/30 p-2 font-mono text-xs"
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="toolbox-paths">Paths (one per line)</Label>
              <textarea
                id="toolbox-paths"
                value={paths}
                onChange={(e) => setPaths(e.target.value)}
                spellCheck={false}
                required
                placeholder="~/.local/bin/tool"
                className="min-h-16 w-full rounded-md border bg-muted/30 p-2 font-mono text-xs"
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="toolbox-source">Source image (optional)</Label>
              <Input
                id="toolbox-source"
                value={sourceImage}
                onChange={(e) => setSourceImage(e.target.value)}
                placeholder="dev-base:1.4"
                className="font-mono"
              />
            </div>
            <label
              htmlFor="toolbox-enabled"
              className="flex items-center gap-2 text-sm"
            >
              <Checkbox
                id="toolbox-enabled"
                checked={enabled}
                onChange={(e) => setEnabled(e.target.checked)}
              />
              Enabled
            </label>
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
