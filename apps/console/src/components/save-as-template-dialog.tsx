import type { SandboxSpec } from "@atelier/spec";
import { type FormEvent, useState } from "react";
import {
  type SavedSpec,
  type TemplateParam,
  useCreateSavedSpec,
  useUpdateSavedSpec,
} from "@/api/queries/saved-specs";
import {
  TemplateMetaFields,
  TemplatePublishToggle,
} from "@/components/template-meta-fields";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { harnessFromAnnotations } from "@/lib/sandbox-status";

/**
 * The one shared "save/publish as template" dialog (design ui-evolution.md
 * §5/D) — reachable from the JSONC editor ("Save → publish to gallery") and
 * from a saved-spec row ("Promote to template"). Both write through the same
 * saved-specs API, so there's exactly one place templates get created.
 *
 * NOTE(other worker): the running-sandbox detail page's "Save this sandbox's
 * spec as a template" entry point may also import this component.
 *
 * Two modes, driven by whether `savedSpec` is supplied:
 * - **New** (`savedSpec` undefined): creates a saved spec from `spec`.
 * - **Promote/edit** (`savedSpec` supplied): updates that saved spec's name +
 *   template metadata in place (spec body itself is untouched here — the
 *   editor already owns spec edits).
 */
export function SaveAsTemplateDialog({
  open,
  onOpenChange,
  spec,
  savedSpec,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  spec: SandboxSpec;
  savedSpec?: Pick<SavedSpec, "id" | "name" | "template" | "meta">;
  onSaved?: () => void;
}) {
  const isPromoting = savedSpec !== undefined;
  const createSavedSpec = useCreateSavedSpec();
  const updateSavedSpec = useUpdateSavedSpec();

  const [name, setName] = useState(savedSpec?.name ?? "");
  const [description, setDescription] = useState(
    savedSpec?.meta?.description ?? "",
  );
  const [icon, setIcon] = useState(savedSpec?.meta?.icon ?? "");
  const [publish, setPublish] = useState(savedSpec?.template ?? true);
  const [params, setParams] = useState<TemplateParam[]>(
    savedSpec?.meta?.params ?? [],
  );

  const harness = harnessFromAnnotations(spec.annotations);
  const isPending = createSavedSpec.isPending || updateSavedSpec.isPending;

  function reset() {
    setName(savedSpec?.name ?? "");
    setDescription(savedSpec?.meta?.description ?? "");
    setIcon(savedSpec?.meta?.icon ?? "");
    setPublish(savedSpec?.template ?? true);
    setParams(savedSpec?.meta?.params ?? []);
  }

  function addRepoUrlParam() {
    setParams((current) => [
      ...current,
      {
        key: "repoUrl",
        label: "Repository URL",
        kind: "repo-url",
        required: true,
      },
    ]);
  }

  function removeParam(key: string) {
    setParams((current) => current.filter((p) => p.key !== key));
  }

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (!name) return;
    const meta = {
      description: description || undefined,
      icon: icon || undefined,
      params: params.length > 0 ? params : undefined,
    };

    if (isPromoting) {
      updateSavedSpec.mutate(
        { id: savedSpec.id, name, template: publish, meta },
        {
          onSuccess: () => {
            onOpenChange(false);
            onSaved?.();
          },
        },
      );
      return;
    }

    createSavedSpec.mutate(
      { name, spec, template: publish, meta },
      {
        onSuccess: () => {
          reset();
          onOpenChange(false);
          onSaved?.();
        },
      },
    );
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) reset();
        onOpenChange(next);
      }}
    >
      <DialogContent className="max-w-lg">
        <form onSubmit={handleSubmit}>
          <DialogHeader>
            <DialogTitle>
              {isPromoting ? "Promote to template" : "Save as template"}
            </DialogTitle>
            <DialogDescription>
              {isPromoting
                ? "Publish this saved spec to the gallery so others can one-tap spawn it."
                : "Save this spec so it can be one-tap spawned later — optionally publish it to the gallery."}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3 py-2">
            <TemplateMetaFields
              idPrefix="template"
              name={name}
              onNameChange={setName}
              description={description}
              onDescriptionChange={setDescription}
              icon={icon}
              onIconChange={setIcon}
              harness={harness}
              autoFocusName
            />
            <div className="space-y-1">
              <div className="flex items-center justify-between">
                <Label>Parameters</Label>
                {params.length === 0 ? (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={addRepoUrlParam}
                  >
                    + Repository URL
                  </Button>
                ) : null}
              </div>
              {params.length === 0 ? (
                <p className="text-xs text-muted-foreground">
                  No parameters — this template spawns as-is.
                </p>
              ) : (
                <ul className="space-y-1">
                  {params.map((param) => (
                    <li
                      key={param.key}
                      className="flex items-center justify-between rounded-md border px-2 py-1 text-sm"
                    >
                      <span>
                        {param.label}{" "}
                        <span className="font-mono text-xs text-muted-foreground">
                          ({param.kind})
                        </span>
                      </span>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={() => removeParam(param.key)}
                      >
                        Remove
                      </Button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
            <TemplatePublishToggle
              id="template-publish"
              checked={publish}
              onChange={setPublish}
              label="Publish to the gallery (visible to everyone in this scope)"
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
              {isPromoting ? "Save" : "Create"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
