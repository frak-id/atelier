import type { ToolboxConfig, ToolboxConfigInput } from "@atelier/spec";
import { useNavigate } from "@tanstack/react-router";
import { Loader2 } from "lucide-react";
import { useState } from "react";
import { useCreateToolbox, useUpdateToolbox } from "@/api/queries/toolboxes";
import { ImageSourcePicker } from "@/components/image-source-picker";
import { RuntimeSurfaceField } from "@/components/runtime-surface-field";
import {
  type SpecEditorApi,
  SpecEditorShell,
} from "@/components/spec-editor-shell";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { parseToolboxInput } from "@/lib/spec";

function linesToArray(text: string): string[] {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

function arrayToLines(values: string[]): string {
  return values.join("\n");
}

function toInput(toolbox?: ToolboxConfig): ToolboxConfigInput {
  if (!toolbox) return { slug: "", description: "", build: [], paths: [] };
  return {
    slug: toolbox.slug,
    description: toolbox.description,
    source: toolbox.source,
    build: toolbox.build,
    paths: toolbox.paths,
    harness: toolbox.harness,
    processes: toolbox.processes,
    ports: toolbox.ports,
    autoInject: toolbox.autoInject,
  };
}

/**
 * Visual + JSON editor for a toolbox, hosted on its own page (create at
 * `/settings/toolboxes/new`, edit at `/settings/toolboxes/$id`) rather than a
 * modal — the toolbox recipe has too many fields (build/paths/processes/
 * ports/harness/source) for a dialog to stay legible. `toolbox` present =>
 * update; absent => create. JSON stays the source of truth via
 * `SpecEditorShell`; this component owns only the visual form + save wiring.
 */
export function ToolboxEditor({
  toolbox,
  owner,
}: {
  toolbox?: ToolboxConfig;
  owner: string;
}) {
  const navigate = useNavigate();
  const createToolbox = useCreateToolbox();
  const updateToolbox = useUpdateToolbox();
  const isEditing = toolbox !== undefined;
  const isPending = createToolbox.isPending || updateToolbox.isPending;

  const [input, setInput] = useState<ToolboxConfigInput>(() =>
    toInput(toolbox),
  );
  // The processes/ports form validates locally (names, ports, readiness),
  // outside the shell's whole-spec parse; track it so Save can't persist a
  // surface with a blocking issue.
  const [visualValid, setVisualValid] = useState(true);

  function handleSave(api: SpecEditorApi<ToolboxConfigInput>) {
    if (api.mode === "visual" && !visualValid) return;
    const value = api.resolve();
    if (!value) return;
    if (isEditing && toolbox) {
      updateToolbox.mutate(
        {
          id: toolbox.id,
          patch: {
            description: value.description,
            build: value.build,
            paths: value.paths,
            autoInject: value.autoInject,
            // `undefined` is dropped by JSON serialization (the server would
            // then keep the old value), so send explicit "empty" clears:
            // `null` for the source union, `[]` for the process/port arrays.
            source: value.source ?? null,
            harness: value.harness ? value.harness : null,
            processes: value.processes ?? [],
            ports: value.ports ?? [],
          },
        },
        {
          onSuccess: () => navigate({ to: "/settings/toolboxes" }),
        },
      );
      return;
    }
    createToolbox.mutate(
      { owner, input: value },
      { onSuccess: () => navigate({ to: "/settings/toolboxes" }) },
    );
  }

  return (
    <SpecEditorShell
      spec={input}
      onSpecChange={setInput}
      parse={parseToolboxInput}
      renderVisual={(spec, onChange) => (
        <ToolboxVisualForm
          spec={spec}
          onChange={onChange}
          isEditing={isEditing}
          onValidityChange={setVisualValid}
        />
      )}
      footer={(api) => (
        <>
          <Button
            type="button"
            variant="outline"
            onClick={() => navigate({ to: "/settings/toolboxes" })}
          >
            Cancel
          </Button>
          <Button
            type="button"
            disabled={isPending || (api.mode === "visual" && !visualValid)}
            onClick={() => handleSave(api)}
          >
            {isPending ? <Loader2 className="animate-spin" /> : null}
            Save
          </Button>
        </>
      )}
    />
  );
}

function ToolboxVisualForm({
  spec,
  onChange,
  isEditing,
  onValidityChange,
}: {
  spec: ToolboxConfigInput;
  onChange: (spec: ToolboxConfigInput) => void;
  isEditing: boolean;
  onValidityChange: (valid: boolean) => void;
}) {
  return (
    <div className="space-y-4">
      <div className="space-y-1">
        <Label htmlFor="toolbox-slug">Slug</Label>
        <Input
          id="toolbox-slug"
          value={spec.slug}
          onChange={(e) => onChange({ ...spec, slug: e.target.value })}
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
          value={spec.description}
          onChange={(e) => onChange({ ...spec, description: e.target.value })}
          required
          placeholder="opencode + code-server (default)"
        />
      </div>
      <div className="space-y-1">
        <Label>Source image (optional)</Label>
        <p className="text-xs text-muted-foreground">
          Overrides the base image build steps run against, when this toolbox's
          tools need a specific base.
        </p>
        <ImageSourcePicker
          value={spec.source ?? { image: "" }}
          allowSnapshot={false}
          onChange={(source) =>
            onChange({
              ...spec,
              source: "image" in source && source.image ? source : undefined,
            })
          }
        />
      </div>
      <div className="space-y-1">
        <Label htmlFor="toolbox-build">
          Build steps (one per line, optional)
        </Label>
        <textarea
          id="toolbox-build"
          value={arrayToLines(spec.build)}
          onChange={(e) =>
            onChange({ ...spec, build: linesToArray(e.target.value) })
          }
          spellCheck={false}
          placeholder="curl -fsSL https://example.com/tool -o ~/.local/bin/tool"
          className="min-h-24 w-full rounded-md border bg-muted/30 p-2 font-mono text-xs"
        />
      </div>
      <div className="space-y-1">
        <Label htmlFor="toolbox-paths">Paths (one per line, optional)</Label>
        <textarea
          id="toolbox-paths"
          value={arrayToLines(spec.paths)}
          onChange={(e) =>
            onChange({ ...spec, paths: linesToArray(e.target.value) })
          }
          spellCheck={false}
          placeholder="~/.local/bin/tool"
          className="min-h-16 w-full rounded-md border bg-muted/30 p-2 font-mono text-xs"
        />
      </div>
      <div className="space-y-1">
        <Label htmlFor="toolbox-harness">Harness (optional)</Label>
        <Input
          id="toolbox-harness"
          value={spec.harness ?? ""}
          onChange={(e) =>
            onChange({ ...spec, harness: e.target.value || undefined })
          }
          placeholder="opencode / pi"
          className="font-mono"
        />
        <p className="text-xs text-muted-foreground">
          If set, spawns using this toolbox get this harness unless the spec
          declares its own.
        </p>
      </div>
      <label
        htmlFor="toolbox-autoinject"
        className="flex items-center gap-2 text-sm"
      >
        <Checkbox
          id="toolbox-autoinject"
          checked={spec.autoInject ?? false}
          onChange={(e) => onChange({ ...spec, autoInject: e.target.checked })}
        />
        Auto-inject into every spawn
      </label>
      <p className="-mt-2 text-xs text-muted-foreground">
        Off = the toolbox is still fully usable, just opt-in (select it per
        spawn). On = applied to all of this owner's sandboxes.
      </p>

      <div className="space-y-2 border-t pt-3">
        <div className="space-y-1">
          <Label>Processes &amp; ports (optional)</Label>
          <p className="text-xs text-muted-foreground">
            The tool's runtime surface, e.g. a web IDE and the port it serves.
            Start heavy ones when first opened so idle sandboxes stay light.
          </p>
        </div>
        <RuntimeSurfaceField
          value={{ processes: spec.processes, ports: spec.ports }}
          onChange={({ processes, ports }) =>
            onChange({ ...spec, processes, ports })
          }
          onValidityChange={onValidityChange}
          defaults={{ lazy: true, port: 8080 }}
          emptyText="Files only: this toolbox runs nothing."
        />
      </div>
    </div>
  );
}
