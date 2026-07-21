import { AlertTriangle } from "lucide-react";
import type { ReactNode } from "react";
import { useState } from "react";
import { SegmentedControl } from "@/components/ui/segmented-control";

export type SpecParseResult<T> =
  | { ok: true; value: T }
  | { ok: false; errors: string[] };

export type EditorMode = "visual" | "json";

/** Passed to the host's footer so Save/Run resolves the *current* editing
 * surface: in JSON mode it parses the draft (and syncs the canonical spec on
 * success), in visual mode it returns the already-canonical spec. Returns
 * `null` and surfaces errors when the JSON draft is invalid. */
export interface SpecEditorApi<T> {
  mode: EditorMode;
  resolve: () => T | null;
}

/**
 * The one shared concern between the prebuild and toolbox editors: a
 * visual↔JSON toggle state machine with JSON kept as the source of truth
 * (oracle guidance, design/… "visual editors").
 *
 * The canonical `spec` object is authoritative. In visual mode the host's
 * form reads/writes it directly via `renderVisual(spec, onSpecChange)`. A
 * `draftText` string exists *only* while in JSON mode. Switching JSON→visual
 * parses+validates the draft and BLOCKS the toggle on failure — edits are
 * never silently dropped, and a visual form is never rendered from an
 * unparseable blob.
 *
 * Note: round-tripping through the visual form drops JSONC comments and any
 * keys the schema doesn't model. Both specs here are `additionalProperties:
 * false`, so there are no extra keys to lose.
 */
export function SpecEditorShell<T>({
  spec,
  onSpecChange,
  parse,
  serialize = (value) => JSON.stringify(value, null, 2),
  renderVisual,
  footer,
  jsonPlaceholder,
}: {
  spec: T;
  onSpecChange: (spec: T) => void;
  parse: (text: string) => SpecParseResult<T>;
  serialize?: (spec: T) => string;
  renderVisual: (spec: T, onSpecChange: (spec: T) => void) => ReactNode;
  footer: (api: SpecEditorApi<T>) => ReactNode;
  jsonPlaceholder?: string;
}) {
  const [mode, setMode] = useState<EditorMode>("visual");
  const [draftText, setDraftText] = useState("");
  const [errors, setErrors] = useState<string[]>([]);

  /** Parse the JSON draft, sync the canonical spec on success, surface errors
   * on failure. Shared by the toggle-to-visual seam and the footer's resolve. */
  function commitDraft(): T | null {
    const result = parse(draftText);
    if (!result.ok) {
      setErrors(result.errors);
      return null;
    }
    setErrors([]);
    onSpecChange(result.value);
    return result.value;
  }

  function switchMode(next: EditorMode) {
    if (next === mode) return;
    if (next === "json") {
      setDraftText(serialize(spec));
      setErrors([]);
      setMode("json");
      return;
    }
    // json → visual: block on invalid draft, keep the user in JSON mode.
    if (commitDraft() === null) return;
    setMode("visual");
  }

  const api: SpecEditorApi<T> = {
    mode,
    resolve: () => (mode === "json" ? commitDraft() : spec),
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-2">
        <SegmentedControl
          options={[
            { value: "visual", label: "Visual" },
            { value: "json", label: "JSON" },
          ]}
          value={mode}
          onChange={switchMode}
        />
      </div>

      {errors.length > 0 ? (
        <div className="space-y-1 rounded-md border border-danger/40 bg-danger/10 p-3">
          <div className="flex items-center gap-2 text-sm font-medium text-danger">
            <AlertTriangle className="size-4" />
            Fix the JSON to continue
          </div>
          <ul className="space-y-0.5 pl-6 text-xs text-danger">
            {errors.map((message, index) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: list resets wholesale on each parse
              <li key={index} className="font-mono">
                {message}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {mode === "visual" ? (
        renderVisual(spec, onSpecChange)
      ) : (
        <textarea
          value={draftText}
          onChange={(e) => setDraftText(e.target.value)}
          spellCheck={false}
          placeholder={jsonPlaceholder}
          className="min-h-96 w-full rounded-md border bg-muted/30 p-3 font-mono text-xs"
        />
      )}

      <div className="flex flex-wrap items-center gap-2">{footer(api)}</div>
    </div>
  );
}
