import type { SandboxSpec } from "@atelier/spec";
import { Download } from "lucide-react";
import { useCreateSavedSpec } from "@/api/queries/saved-specs";
import { Button } from "@/components/ui/button";
import { ALL_TEMPLATES, templateToSavedSpecImport } from "@/lib/templates";

/**
 * The seed-catalog import rows, shared by the Spawn (Builder) and
 * Settings → Templates surfaces (design ui-evolution.md §2.3). Importing forks
 * a static example into a real, org-owned saved spec (unpublished) via the one
 * saved-specs API — the static catalog is never spawned directly. Renders rows
 * only; each caller supplies its own container/heading. Pass `onOpenInEditor`
 * to also offer "Open in editor" (Builder lens only).
 */
export function TemplateImportList({
  onOpenInEditor,
}: {
  onOpenInEditor?: (spec: SandboxSpec) => void;
}) {
  const createSavedSpec = useCreateSavedSpec();

  return (
    <div className="space-y-2">
      {ALL_TEMPLATES.map((template) => {
        const { name, spec } = templateToSavedSpecImport(template);
        return (
          <div
            key={template.id}
            className="flex flex-col gap-2 rounded-md border p-3 sm:flex-row sm:items-center sm:justify-between"
          >
            <div className="flex min-w-0 flex-col gap-0.5">
              <span className="truncate font-medium">{name}</span>
              <span className="truncate text-xs text-muted-foreground">
                {template.description}
              </span>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                loading={createSavedSpec.isPending}
                onClick={() => createSavedSpec.mutate({ name, spec })}
              >
                <Download />
                Import
              </Button>
              {onOpenInEditor ? (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => onOpenInEditor(spec)}
                >
                  Open in editor
                </Button>
              ) : null}
            </div>
          </div>
        );
      })}
    </div>
  );
}
