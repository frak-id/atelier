import type { SandboxSpec } from "@atelier/spec";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { LayoutGrid, Pencil } from "lucide-react";
import { type FormEvent, useState } from "react";
import {
  type SavedSpec,
  savedSpecsListQuery,
  useCreateSavedSpec,
  useUpdateSavedSpec,
} from "@/api/queries/saved-specs";
import { TemplateImportList } from "@/components/template-import-list";
import {
  TemplateMetaFields,
  TemplatePublishToggle,
} from "@/components/template-meta-fields";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { EmptyState } from "@/components/ui/empty-state";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { formatRelativeTime } from "@/lib/formatters";
import { harnessFromAnnotations } from "@/lib/sandbox-status";
import { parseSpecJsonc, validateSandboxSpec } from "@/lib/spec";

export const Route = createFileRoute("/settings/templates")({
  component: TemplatesPage,
});

function TemplatesPage() {
  const {
    data: savedSpecs,
    isPending,
    isError,
    error,
  } = useQuery(savedSpecsListQuery());
  const [editing, setEditing] = useState<SavedSpec | undefined>();
  const [creating, setCreating] = useState(false);

  return (
    <div className="space-y-6">
      <div className="space-y-3">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
          <p className="max-w-2xl text-sm text-muted-foreground">
            A template is a saved spec published to the spawn gallery (
            <code>template: true</code>). Publish an existing saved spec from
            the Spawn page ("Promote to template"), or author one here from
            scratch or from an example.
          </p>
          <Button size="sm" onClick={() => setCreating(true)}>
            New template
          </Button>
        </div>
        {isPending ? (
          <Skeleton className="h-16 w-full" />
        ) : isError ? (
          <p className="text-sm text-destructive">
            {error instanceof Error ? error.message : "Failed to load"}
          </p>
        ) : !savedSpecs || savedSpecs.length === 0 ? (
          <EmptyState
            icon={LayoutGrid}
            title="No saved specs yet"
            description="Import an example below, or save a spec from the Spawn page."
          />
        ) : (
          <div className="space-y-2">
            {savedSpecs.map((savedSpec) => (
              <TemplateRow
                key={savedSpec.id}
                savedSpec={savedSpec}
                onEdit={() => setEditing(savedSpec)}
              />
            ))}
          </div>
        )}
      </div>

      <ImportExamplesSection />

      <TemplateDialog open={creating} onOpenChange={setCreating} />
      <TemplateDialog
        key={editing?.id ?? "none"}
        open={editing !== undefined}
        onOpenChange={(next) => {
          if (!next) setEditing(undefined);
        }}
        savedSpec={editing}
      />
    </div>
  );
}

function TemplateRow({
  savedSpec,
  onEdit,
}: {
  savedSpec: SavedSpec;
  onEdit: () => void;
}) {
  const updateSavedSpec = useUpdateSavedSpec();
  const harness = harnessFromAnnotations(savedSpec.spec.annotations);

  return (
    <Card>
      <CardContent className="flex flex-col gap-2 p-3">
        <div className="flex items-center justify-between gap-2">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <span className="truncate font-medium text-sm">
              {savedSpec.name}
            </span>
            {savedSpec.orgId ? <Badge variant="outline">org</Badge> : null}
            {harness ? (
              <Badge variant="neutral">harness: {harness}</Badge>
            ) : null}
            {savedSpec.meta?.params && savedSpec.meta.params.length > 0 ? (
              <Badge variant="outline">
                {savedSpec.meta.params.length} param
                {savedSpec.meta.params.length > 1 ? "s" : ""}
              </Badge>
            ) : null}
            <span className="text-xs text-muted-foreground">
              {formatRelativeTime(savedSpec.updatedAt)}
            </span>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              loading={updateSavedSpec.isPending}
              onClick={() =>
                updateSavedSpec.mutate({
                  id: savedSpec.id,
                  template: !savedSpec.template,
                })
              }
            >
              {savedSpec.template ? "Unpublish" : "Publish"}
            </Button>
            <Button
              variant="outline"
              size="icon"
              onClick={onEdit}
              aria-label="Edit template"
            >
              <Pencil />
            </Button>
          </div>
        </div>
        {savedSpec.template ? (
          <Badge variant="success" className="w-fit">
            published to gallery
          </Badge>
        ) : null}
        {savedSpec.meta?.description ? (
          <p className="text-sm text-muted-foreground">
            {savedSpec.meta.description}
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}

/** Builder/admin "cold start" seeds (design ui-evolution.md §2.3) — importing
 * forks a seed into a real, unpublished saved spec; publishing is a separate,
 * explicit step (the toggle above). */
function ImportExamplesSection() {
  return (
    <div className="space-y-2">
      <h2 className="text-sm font-medium text-muted-foreground">
        Examples — import to get started
      </h2>
      <TemplateImportList />
    </div>
  );
}

/**
 * Create/edit a template: name + metadata (description/icon/params) +
 * harness (from the spec's annotation, read-only here — set it by authoring
 * the right spec) + the spec itself as JSONC. Reuses the same saved-specs API
 * as `SaveAsTemplateDialog`; this is the Settings authoring surface, that one
 * is the inline "promote what I'm looking at" surface (design
 * ui-evolution.md §5/D).
 */
function TemplateDialog({
  open,
  onOpenChange,
  savedSpec,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  savedSpec?: SavedSpec;
}) {
  const createSavedSpec = useCreateSavedSpec();
  const updateSavedSpec = useUpdateSavedSpec();
  const isEditing = savedSpec !== undefined;

  const [name, setName] = useState(savedSpec?.name ?? "");
  const [description, setDescription] = useState(
    savedSpec?.meta?.description ?? "",
  );
  const [icon, setIcon] = useState(savedSpec?.meta?.icon ?? "");
  const [publish, setPublish] = useState(savedSpec?.template ?? false);
  const [specText, setSpecText] = useState(
    savedSpec ? JSON.stringify(savedSpec.spec, null, 2) : "",
  );
  const [specError, setSpecError] = useState<string | undefined>();

  function reset() {
    setName(savedSpec?.name ?? "");
    setDescription(savedSpec?.meta?.description ?? "");
    setIcon(savedSpec?.meta?.icon ?? "");
    setPublish(savedSpec?.template ?? false);
    setSpecText(savedSpec ? JSON.stringify(savedSpec.spec, null, 2) : "");
    setSpecError(undefined);
  }

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (!name) return;
    const meta = {
      description: description || undefined,
      icon: icon || undefined,
      params: savedSpec?.meta?.params,
    };

    if (isEditing) {
      let spec: SandboxSpec | undefined;
      if (specText.trim()) {
        const parsed = parseSpecJsonc(specText);
        if (!parsed.ok) {
          setSpecError(parsed.errors[0]);
          return;
        }
        const validated = validateSandboxSpec(parsed.value);
        if (!validated.ok) {
          setSpecError(validated.errors[0]);
          return;
        }
        spec = validated.spec;
      }
      setSpecError(undefined);
      updateSavedSpec.mutate(
        { id: savedSpec.id, name, spec, template: publish, meta },
        { onSuccess: () => onOpenChange(false) },
      );
      return;
    }

    const parsed = parseSpecJsonc(specText);
    if (!parsed.ok) {
      setSpecError(parsed.errors[0]);
      return;
    }
    const validated = validateSandboxSpec(parsed.value);
    if (!validated.ok) {
      setSpecError(validated.errors[0]);
      return;
    }
    setSpecError(undefined);
    createSavedSpec.mutate(
      { name, spec: validated.spec, template: publish, meta },
      {
        onSuccess: () => {
          reset();
          onOpenChange(false);
        },
      },
    );
  }

  const isPending = createSavedSpec.isPending || updateSavedSpec.isPending;
  const harness = harnessFromAnnotations(savedSpec?.spec.annotations);

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) reset();
        onOpenChange(next);
      }}
    >
      <DialogContent className="max-w-2xl">
        <form onSubmit={handleSubmit}>
          <DialogHeader>
            <DialogTitle>
              {isEditing ? "Edit template" : "New template"}
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-3 py-2">
            <TemplateMetaFields
              idPrefix="tpl"
              name={name}
              onNameChange={setName}
              description={description}
              onDescriptionChange={setDescription}
              icon={icon}
              onIconChange={setIcon}
              harness={harness}
              autoFocusName={!isEditing}
              harnessHint="set by the harness composer used in the spec below."
            />
            <div className="space-y-1">
              <Label htmlFor="tpl-spec">
                Spec (JSONC){isEditing ? " — leave unchanged to keep it" : ""}
              </Label>
              <textarea
                id="tpl-spec"
                value={specText}
                onChange={(e) => setSpecText(e.target.value)}
                spellCheck={false}
                required={!isEditing}
                className="min-h-56 w-full rounded-md border bg-muted/30 p-3 font-mono text-xs"
                placeholder='{"source": {"image": "dev-base-v2"}, "resources": {"vcpus": 2, "memoryMb": 2048}}'
              />
              {specError ? (
                <p className="text-sm text-destructive">{specError}</p>
              ) : null}
            </div>
            <TemplatePublishToggle
              id="tpl-publish"
              checked={publish}
              onChange={setPublish}
            />
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
            >
              Cancel
            </Button>
            <Button type="submit" loading={isPending}>
              Save
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
