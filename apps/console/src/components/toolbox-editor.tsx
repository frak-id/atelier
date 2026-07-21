import type { ToolboxConfig, ToolboxConfigInput } from "@atelier/spec";
import { useNavigate } from "@tanstack/react-router";
import { ChevronDown, ChevronRight, Loader2 } from "lucide-react";
import { useEffect, useState } from "react";
import { useCreateToolbox, useUpdateToolbox } from "@/api/queries/toolboxes";
import { ImageSourcePicker } from "@/components/image-source-picker";
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
  // The Advanced (processes/ports) JSON sub-fields validate locally, outside
  // the shell's whole-spec parse; track their validity so Save can't persist a
  // stale value while a sub-field is broken.
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
  const [advancedOpen, setAdvancedOpen] = useState(
    () =>
      (spec.processes && spec.processes.length > 0) ||
      (spec.ports && spec.ports.length > 0),
  );
  const [processesText, setProcessesText] = useState(() =>
    spec.processes ? JSON.stringify(spec.processes, null, 2) : "",
  );
  const [portsText, setPortsText] = useState(() =>
    spec.ports ? JSON.stringify(spec.ports, null, 2) : "",
  );
  const [processesError, setProcessesError] = useState<string | undefined>();
  const [portsError, setPortsError] = useState<string | undefined>();

  // Report combined Advanced-field validity up so Save can be gated. Runs on
  // mount too, so a remount (visual↔JSON toggle) re-establishes the state.
  useEffect(() => {
    onValidityChange(!processesError && !portsError);
  }, [processesError, portsError, onValidityChange]);

  function commitProcesses(text: string) {
    setProcessesText(text);
    const trimmed = text.trim();
    if (!trimmed) {
      setProcessesError(undefined);
      onChange({ ...spec, processes: undefined });
      return;
    }
    try {
      const value = JSON.parse(trimmed);
      if (!Array.isArray(value))
        throw new Error("Processes must be a JSON array");
      setProcessesError(undefined);
      onChange({ ...spec, processes: value });
    } catch (err) {
      setProcessesError(
        err instanceof Error ? err.message : "Processes is not valid JSON",
      );
    }
  }

  function commitPorts(text: string) {
    setPortsText(text);
    const trimmed = text.trim();
    if (!trimmed) {
      setPortsError(undefined);
      onChange({ ...spec, ports: undefined });
      return;
    }
    try {
      const value = JSON.parse(trimmed);
      if (!Array.isArray(value)) throw new Error("Ports must be a JSON array");
      setPortsError(undefined);
      onChange({ ...spec, ports: value });
    } catch (err) {
      setPortsError(
        err instanceof Error ? err.message : "Ports is not valid JSON",
      );
    }
  }

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

      <div className="border-t pt-3">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          aria-expanded={advancedOpen}
          onClick={() => setAdvancedOpen((open) => !open)}
        >
          {advancedOpen ? <ChevronDown /> : <ChevronRight />}
          Advanced (processes &amp; ports)
        </Button>
        {advancedOpen ? (
          <div className="mt-3 space-y-3">
            <div className="space-y-1">
              <Label htmlFor="toolbox-processes">
                Processes (JSON array, optional)
              </Label>
              <textarea
                id="toolbox-processes"
                value={processesText}
                onChange={(e) => commitProcesses(e.target.value)}
                spellCheck={false}
                placeholder={
                  '[{"name":"vscode","command":"code-server ...","lazy":true,"readiness":{"port":8080}}]'
                }
                className="min-h-24 w-full rounded-md border bg-muted/30 p-2 font-mono text-xs"
              />
              {processesError ? (
                <p className="text-sm text-destructive">{processesError}</p>
              ) : null}
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
                onChange={(e) => commitPorts(e.target.value)}
                spellCheck={false}
                placeholder={
                  '[{"name":"vscode","port":8080,"public":true,"auth":"forward"}]'
                }
                className="min-h-16 w-full rounded-md border bg-muted/30 p-2 font-mono text-xs"
              />
              {portsError ? (
                <p className="text-sm text-destructive">{portsError}</p>
              ) : null}
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}
