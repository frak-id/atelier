import type { PrebuildRecord, TemplateComposition } from "@atelier/spec";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import { prebuildsListQuery } from "@/api/queries/prebuilds";
import { toolboxesListQuery } from "@/api/queries/toolboxes";
import { ToolboxPicker } from "@/components/toolbox-picker";
import { Card, CardContent } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { deriveCompositionHarness } from "@/lib/composition";
import { cn } from "@/lib/utils";

/** The resolved picks reported up to the hosting dialog: a stored `composition`
 * (prebuild recipe + toolbox selectors), the prebuild's current snapshot to
 * seed `source`, and the display harness the toolboxes declare. `null` until a
 * prebuild is chosen. */
export interface TemplateCompositionSelection {
  composition: TemplateComposition;
  source: { snapshot: string };
  harness?: string;
}

/** Short, human summary of a prebuild's opaque metadata (workspace/repo…). */
function metadataSummary(metadata?: Record<string, string>): string | null {
  if (!metadata) return null;
  const entries = Object.entries(metadata);
  if (entries.length === 0) return null;
  return entries.map(([k, v]) => `${k}: ${v}`).join(" · ");
}

/**
 * The shared "pick a prebuild + toolboxes" surface used by every template
 * authoring flow (Settings "New from prebuild + toolbox", the promote/editor
 * "Save as template" dialog). It stores *references* — a prebuild recipe and
 * toolbox selectors — never pinned toolset digests, so the template follows an
 * updated prebuild/toolbox to its latest build. Only prebuilds that carry a
 * recipe (`spec`) are offered, since a pause/manual snapshot can't be
 * re-resolved.
 *
 * Self-contained: it owns the selection and reports it via `onChange`
 * (`null` when no prebuild is picked). The host owns name/meta/resources.
 */
export function TemplateCompositionFields({
  idPrefix = "tcomp",
  initialPrebuildRef,
  initialToolboxes,
  onChange,
}: {
  /** Namespaces the radio group so two instances can't collide if ever
   * rendered together. */
  idPrefix?: string;
  initialPrebuildRef?: string;
  initialToolboxes?: string[];
  onChange: (selection: TemplateCompositionSelection | null) => void;
}) {
  const prebuilds = useQuery(prebuildsListQuery());
  const toolboxes = useQuery(toolboxesListQuery());

  const [prebuildRef, setPrebuildRef] = useState<string | null>(
    initialPrebuildRef ?? null,
  );
  const [selected, setSelected] = useState<Set<string>>(
    () => new Set(initialToolboxes ?? []),
  );

  // Only prebuilds with a recipe can be re-resolved to their latest snapshot.
  const buildable = useMemo(
    () =>
      (prebuilds.data ?? []).filter(
        (
          p,
        ): p is PrebuildRecord & {
          spec: NonNullable<PrebuildRecord["spec"]>;
        } => p.spec !== undefined,
      ),
    [prebuilds.data],
  );
  const toolboxList = useMemo(() => toolboxes.data ?? [], [toolboxes.data]);
  const harness = useMemo(
    () => deriveCompositionHarness(toolboxList, selected),
    [toolboxList, selected],
  );

  const selection = useMemo<TemplateCompositionSelection | null>(() => {
    const prebuild = buildable.find((p) => p.ref === prebuildRef);
    if (!prebuild) return null;
    const selectors = [...selected];
    return {
      composition: {
        prebuild: prebuild.spec,
        ...(selectors.length > 0 ? { toolboxes: selectors } : {}),
      },
      source: { snapshot: prebuild.ref },
      harness,
    };
  }, [buildable, prebuildRef, selected, harness]);

  // Report up without requiring the parent to memoize `onChange`. `selection`
  // is referentially stable between unrelated renders (its inputs are), so the
  // parent only re-renders on a real change.
  const onChangeRef = useRef(onChange);
  useEffect(() => {
    onChangeRef.current = onChange;
  });
  useEffect(() => {
    onChangeRef.current(selection);
  }, [selection]);

  function toggleToolbox(selector: string) {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(selector)) next.delete(selector);
      else next.add(selector);
      return next;
    });
  }

  return (
    <>
      <div className="space-y-2">
        <Label>Prebuild</Label>
        <p className="text-xs text-muted-foreground">
          The template boots from this prebuild and re-resolves it to the latest
          snapshot on every spawn.
        </p>
        {prebuilds.isPending ? (
          <Skeleton className="h-16 w-full" />
        ) : prebuilds.isError ? (
          <p className="text-sm text-destructive">Failed to load prebuilds.</p>
        ) : buildable.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No prebuilds with a stored recipe yet — run one from Settings →
            Prebuilds first.
          </p>
        ) : (
          <div className="space-y-2">
            {buildable.map((prebuild) => {
              const summary = metadataSummary(prebuild.metadata);
              const isSelected = prebuildRef === prebuild.ref;
              return (
                <Card
                  key={prebuild.ref}
                  className={cn(
                    "cursor-pointer transition-colors hover:border-primary/60",
                    isSelected && "border-primary ring-1 ring-primary",
                  )}
                  onClick={() => setPrebuildRef(prebuild.ref)}
                >
                  <CardContent className="flex items-center gap-2 p-3">
                    <input
                      type="radio"
                      name={`${idPrefix}-prebuild`}
                      checked={isSelected}
                      onChange={() => setPrebuildRef(prebuild.ref)}
                      onClick={(e) => e.stopPropagation()}
                    />
                    <div className="min-w-0">
                      <span className="truncate font-mono text-sm">
                        {prebuild.ref}
                      </span>
                      <div className="text-xs text-muted-foreground">
                        {prebuild.image}
                        {summary ? ` · ${summary}` : ""}
                      </div>
                    </div>
                  </CardContent>
                </Card>
              );
            })}
          </div>
        )}
      </div>

      <div className="space-y-2">
        <Label>Toolboxes</Label>
        <p className="text-xs text-muted-foreground">
          Selectors are stored, not pinned toolset digests, so an updated
          toolbox is picked up on the next spawn. Auto-inject toolboxes always
          apply.
        </p>
        {toolboxes.isPending ? (
          <Skeleton className="h-16 w-full" />
        ) : toolboxes.isError ? (
          <p className="text-sm text-destructive">Failed to load toolboxes.</p>
        ) : toolboxList.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No toolboxes yet — create one from Settings → Toolboxes.
          </p>
        ) : (
          <ToolboxPicker
            toolboxes={toolboxList}
            selected={selected}
            onToggle={toggleToolbox}
          />
        )}
      </div>
    </>
  );
}
