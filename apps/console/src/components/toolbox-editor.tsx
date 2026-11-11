import type { ToolboxConfig, ToolboxConfigInput } from "@atelier/spec";
import { useNavigate } from "@tanstack/react-router";
import { Loader2 } from "lucide-react";
import { useEffect, useState } from "react";
import { useCreateToolbox, useUpdateToolbox } from "@/api/queries/toolboxes";
import { ImageSourcePicker } from "@/components/image-source-picker";
import { RuntimeSurfaceField } from "@/components/runtime-surface-field";
import {
  type SpecEditorApi,
  SpecEditorShell,
} from "@/components/spec-editor-shell";
import { ToolboxFilesField } from "@/components/toolbox-files-field";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
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

function sameLines(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((line, i) => line === b[i]);
}

/**
 * A one-entry-per-line textarea over a `string[]`. It keeps the raw text
 * locally so a trailing newline or a blank line survives while typing (the
 * parsed array drops them), and resyncs when the array changes from outside
 * (e.g. an edit in JSON mode).
 */
function LinesTextarea({
  id,
  value,
  onChange,
  placeholder,
  className,
}: {
  id: string;
  value: string[];
  onChange: (value: string[]) => void;
  placeholder: string;
  className: string;
}) {
  const [text, setText] = useState(() => arrayToLines(value));
  useEffect(() => {
    setText((current) =>
      sameLines(linesToArray(current), value) ? current : arrayToLines(value),
    );
  }, [value]);
  return (
    <Textarea
      id={id}
      value={text}
      onChange={(e) => {
        setText(e.target.value);
        onChange(linesToArray(e.target.value));
      }}
      spellCheck={false}
      placeholder={placeholder}
      className={className}
    />
  );
}

/** A stable empty list, so an unset field doesn't resync on every render. */
const NO_LINES: string[] = [];

function toInput(
  toolbox?: ToolboxConfig,
  initial?: ToolboxConfigInput,
): ToolboxConfigInput {
  if (!toolbox) {
    return initial ?? { slug: "", description: "", build: [], paths: [] };
  }
  return {
    slug: toolbox.slug,
    description: toolbox.description,
    source: toolbox.source,
    build: toolbox.build,
    paths: toolbox.paths,
    harness: toolbox.harness,
    processes: toolbox.processes,
    ports: toolbox.ports,
    ...(toolbox.files && toolbox.files.length > 0
      ? { files: toolbox.files }
      : {}),
    autoInject: toolbox.autoInject,
    ...(toolbox.refresh.length > 0 ? { refresh: toolbox.refresh } : {}),
    ...(toolbox.refreshSchedule
      ? { refreshSchedule: toolbox.refreshSchedule }
      : {}),
  };
}

/**
 * Visual + JSON editor for a toolbox, hosted on its own page (create at
 * `/library/toolboxes/new`, edit at `/library/toolboxes/$id`) rather than a
 * modal — the toolbox recipe has too many fields (build/paths/processes/
 * ports/harness/source) for a dialog to stay legible. `toolbox` present =>
 * update; absent => create. JSON stays the source of truth via
 * `SpecEditorShell`; this component owns only the visual form + save wiring.
 * `initial` prefills a create (a suggested toolbox); ignored on edit.
 */
export function ToolboxEditor({
  toolbox,
  initial,
  owner,
}: {
  toolbox?: ToolboxConfig;
  initial?: ToolboxConfigInput;
  owner: string;
}) {
  const navigate = useNavigate();
  const createToolbox = useCreateToolbox();
  const updateToolbox = useUpdateToolbox();
  const isEditing = toolbox !== undefined;
  const isPending = createToolbox.isPending || updateToolbox.isPending;

  const [input, setInput] = useState<ToolboxConfigInput>(() =>
    toInput(toolbox, initial),
  );
  // The processes/ports form validates locally (names, ports, readiness),
  // outside the shell's whole-spec parse; track it so Save can't persist a
  // surface with a blocking issue.
  const [visualValid, setVisualValid] = useState(true);

  function handleSave(api: SpecEditorApi<ToolboxConfigInput>) {
    if (api.mode === "visual" && !visualValid) return;
    const resolved = api.resolve();
    if (!resolved) return;
    // The schedule field keeps what was typed; store it trimmed.
    const schedule = resolved.refreshSchedule?.trim();
    const value: ToolboxConfigInput = {
      ...resolved,
      refreshSchedule: schedule ? schedule : undefined,
    };
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
            files: value.files ?? [],
            refresh: value.refresh ?? [],
            refreshSchedule: value.refreshSchedule || null,
          },
        },
        {
          onSuccess: () => navigate({ to: "/library/toolboxes" }),
        },
      );
      return;
    }
    createToolbox.mutate(
      { owner, input: value },
      { onSuccess: () => navigate({ to: "/library/toolboxes" }) },
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
            onClick={() => navigate({ to: "/library/toolboxes" })}
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
          placeholder="opencode coding agent"
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
        <LinesTextarea
          id="toolbox-build"
          value={spec.build}
          onChange={(build) => onChange({ ...spec, build })}
          placeholder="curl -fsSL https://example.com/tool -o ~/.local/bin/tool"
          className="min-h-24 p-2"
        />
      </div>
      <div className="space-y-1">
        <Label htmlFor="toolbox-paths">Paths (one per line, optional)</Label>
        <LinesTextarea
          id="toolbox-paths"
          value={spec.paths}
          onChange={(paths) => onChange({ ...spec, paths })}
          placeholder="~/.local/bin/tool"
          className="min-h-16 p-2"
        />
      </div>
      <div className="space-y-2 rounded-md border p-3">
        <div className="space-y-1">
          <Label htmlFor="toolbox-refresh">
            Update commands (one per line, optional)
          </Label>
          <LinesTextarea
            id="toolbox-refresh"
            value={spec.refresh ?? NO_LINES}
            onChange={(refresh) =>
              onChange({
                ...spec,
                refresh: refresh.length > 0 ? refresh : undefined,
              })
            }
            placeholder="pi update --all"
            className="min-h-12 p-2"
          />
          <p className="text-xs text-muted-foreground">
            Refresh runs these on the server, on top of the current version,
            then saves the paths above as a new version and pins it. When the
            files did not change, nothing is saved.
          </p>
        </div>
        <div className="space-y-1">
          <Label htmlFor="toolbox-refresh-schedule">
            Refresh schedule (optional)
          </Label>
          <Input
            id="toolbox-refresh-schedule"
            value={spec.refreshSchedule ?? ""}
            onChange={(e) =>
              onChange({
                ...spec,
                refreshSchedule: e.target.value || undefined,
              })
            }
            placeholder="0 4 * * *   or   @daily"
            className="font-mono"
          />
          <p className="text-xs text-muted-foreground">
            Cron, in UTC, at most once an hour. Empty: only when you press
            Refresh.
          </p>
        </div>
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
        Auto-inject into every spawn in this org
      </label>
      <p className="-mt-2 text-xs text-muted-foreground">
        Off = the toolbox is still fully usable, just opt-in (select it per
        spawn). On = applied to every sandbox spawned in this organization.
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

      <div className="space-y-2 border-t pt-3">
        <div className="space-y-1">
          <Label>Files (optional)</Label>
          <p className="text-xs text-muted-foreground">
            Written into every sandbox this toolbox applies to, e.g. a config
            file holding an API key. Pick "Secret" to read the content from an
            organization secret instead of storing it here. A toolbox with only
            files is fine.
          </p>
        </div>
        <ToolboxFilesField
          value={spec.files ?? []}
          onChange={(files) =>
            onChange({ ...spec, files: files.length > 0 ? files : undefined })
          }
        />
      </div>
    </div>
  );
}
