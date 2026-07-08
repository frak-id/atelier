import type {
  CreateSandboxRequest,
  SandboxSpec,
  TemplateComposition,
  ToolboxConfig,
} from "@atelier/spec";
import { toolboxSelector } from "@/components/toolbox-picker";
import { HARNESS_ANNOTATION_KEY } from "@/lib/sandbox-status";

// Re-exported so template dialogs import the display-only harness annotation
// key from the composition module they already use.
export { HARNESS_ANNOTATION_KEY };

/**
 * Thread a template's `composition` (a prebuild recipe + toolbox selectors)
 * onto a spawn request so the seam resolves them to the latest snapshot/toolset
 * refs at spawn — the whole point of a composition template is that it follows
 * an updated prebuild/toolbox instead of pinning them. A spec without a
 * composition spawns unchanged.
 */
export function specToSpawnRequest(
  spec: SandboxSpec,
  composition?: TemplateComposition | null,
): CreateSandboxRequest {
  return {
    ...spec,
    ...(composition?.prebuild ? { prebuild: composition.prebuild } : {}),
    ...(composition?.toolboxes && composition.toolboxes.length > 0
      ? { toolboxes: composition.toolboxes }
      : {}),
  };
}

/**
 * The harness a composition's toolboxes declare, for display only. Mirrors the
 * seam's "a toolbox that always applies or was picked wins" rule (precedence
 * between toolboxes is resolved server-side); the first such toolbox with a
 * harness is used as the label.
 */
export function deriveCompositionHarness(
  toolboxes: ToolboxConfig[],
  selected: ReadonlySet<string>,
): string | undefined {
  return toolboxes.find(
    (t) => (t.autoInject || selected.has(toolboxSelector(t))) && t.harness,
  )?.harness;
}

/** Set/replace/clear the display-only harness annotation, dropping it when no
 * toolbox declares a harness so a stale value from the base spec can't linger. */
function withHarnessAnnotation(
  base: Record<string, string> | undefined,
  harness: string | undefined,
): Record<string, string> | undefined {
  const next = { ...base };
  delete next[HARNESS_ANNOTATION_KEY];
  if (harness) next[HARNESS_ANNOTATION_KEY] = harness;
  return Object.keys(next).length > 0 ? next : undefined;
}

/**
 * Overlay a picked prebuild snapshot + toolbox-declared harness onto a base
 * spec when attaching a composition. The snapshot only seeds `source` (the seam
 * re-resolves it and the toolbox selectors to their latest builds at spawn), so
 * any `toolsets` the base spec pinned are dropped — the composition's toolboxes
 * resolve their own, and the seam only dedupes exact ref matches, so keeping the
 * old digests would double-apply them.
 */
export function composeTemplateSpec(
  base: SandboxSpec,
  selection: { source: { snapshot: string }; harness?: string },
): SandboxSpec {
  const { toolsets: _pinned, annotations, ...rest } = base;
  const nextAnnotations = withHarnessAnnotation(annotations, selection.harness);
  return {
    ...rest,
    source: selection.source,
    ...(nextAnnotations ? { annotations: nextAnnotations } : {}),
  };
}
