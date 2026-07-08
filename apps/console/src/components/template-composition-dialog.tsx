import { type FormEvent, useState } from "react";
import { useCreateSavedSpec } from "@/api/queries/saved-specs";
import {
  TemplateCompositionFields,
  type TemplateCompositionSelection,
} from "@/components/template-composition-fields";
import {
  TemplateMetaFields,
  TemplatePublishToggle,
} from "@/components/template-meta-fields";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { HARNESS_ANNOTATION_KEY } from "@/lib/composition";

const DEFAULT_VCPUS = 2;
const DEFAULT_MEMORY_MB = 2048;

/**
 * Author a template from an existing prebuild + toolbox(es), storing the
 * *references* (a prebuild recipe + toolbox selectors) instead of a pinned
 * snapshot/toolset. The seam re-resolves both at spawn, so the template
 * follows an updated prebuild or toolbox to its latest build (see the saved
 * spec's `composition`). The prebuild/toolbox picking lives in the shared
 * `TemplateCompositionFields`; this dialog owns name/meta/resources.
 */
export function TemplateCompositionDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const createSavedSpec = useCreateSavedSpec();

  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [icon, setIcon] = useState("");
  const [publish, setPublish] = useState(false);
  const [selection, setSelection] =
    useState<TemplateCompositionSelection | null>(null);
  const [vcpus, setVcpus] = useState(String(DEFAULT_VCPUS));
  const [memoryMb, setMemoryMb] = useState(String(DEFAULT_MEMORY_MB));
  const [formError, setFormError] = useState<string | undefined>();

  const harness = selection?.harness;

  function reset() {
    setName("");
    setDescription("");
    setIcon("");
    setPublish(false);
    setSelection(null);
    setVcpus(String(DEFAULT_VCPUS));
    setMemoryMb(String(DEFAULT_MEMORY_MB));
    setFormError(undefined);
  }

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (!name) return;
    if (!selection) {
      setFormError("Pick a prebuild to base the template on.");
      return;
    }
    const cpus = Number(vcpus);
    const mem = Number(memoryMb);
    if (!Number.isFinite(cpus) || cpus < 1) {
      setFormError("vCPUs must be at least 1.");
      return;
    }
    if (!Number.isFinite(mem) || mem < 256) {
      setFormError("Memory must be at least 256 MB.");
      return;
    }
    setFormError(undefined);

    // `source` holds the prebuild's current snapshot as a sensible default;
    // the seam overrides it with the freshly-resolved snapshot at spawn.
    createSavedSpec.mutate(
      {
        name,
        spec: {
          source: selection.source,
          resources: { vcpus: cpus, memoryMb: mem },
          ...(harness
            ? { annotations: { [HARNESS_ANNOTATION_KEY]: harness } }
            : {}),
        },
        template: publish,
        meta: {
          description: description || undefined,
          icon: icon || undefined,
        },
        composition: selection.composition,
      },
      {
        onSuccess: () => {
          reset();
          onOpenChange(false);
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
      <DialogContent className="max-w-2xl">
        <form onSubmit={handleSubmit}>
          <DialogHeader>
            <DialogTitle>New template from prebuild + toolbox</DialogTitle>
          </DialogHeader>
          <div className="max-h-[70vh] space-y-4 overflow-y-auto py-2">
            <TemplateMetaFields
              idPrefix="tcomp"
              name={name}
              onNameChange={setName}
              description={description}
              onDescriptionChange={setDescription}
              icon={icon}
              onIconChange={setIcon}
              harness={harness}
              autoFocusName
              harnessHint="declared by a selected toolbox."
            />

            <TemplateCompositionFields onChange={setSelection} />

            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <Label htmlFor="tcomp-vcpus">vCPUs</Label>
                <Input
                  id="tcomp-vcpus"
                  type="number"
                  min={1}
                  value={vcpus}
                  onChange={(e) => setVcpus(e.target.value)}
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="tcomp-memory">Memory (MB)</Label>
                <Input
                  id="tcomp-memory"
                  type="number"
                  min={256}
                  step={256}
                  value={memoryMb}
                  onChange={(e) => setMemoryMb(e.target.value)}
                />
              </div>
            </div>

            {formError ? (
              <p className="text-sm text-destructive">{formError}</p>
            ) : null}

            <TemplatePublishToggle
              id="tcomp-publish"
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
            <Button type="submit" loading={createSavedSpec.isPending}>
              Create template
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
