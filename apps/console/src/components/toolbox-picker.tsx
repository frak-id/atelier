import type { ToolboxConfig } from "@atelier/spec";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { cn } from "@/lib/utils";

/** `tb/<ownerType>/<ownerId>/<slug>` — the selector the seam resolves. */
function toolboxSelector(toolbox: ToolboxConfig): string {
  return `tb/${toolbox.ownerType}/${toolbox.ownerId}/${toolbox.slug}`;
}

/**
 * Select toolboxes (the user-facing unit) for a spawn. Unlike the toolset
 * picker this lists the *recipe*, so a process-only toolbox (no files, no
 * built toolset — e.g. the browser stack baked into the base image) is still
 * selectable. Auto-inject toolboxes are shown checked + locked: they always
 * apply, the picker just makes that visible.
 */
export function ToolboxPicker({
  toolboxes,
  selected,
  onToggle,
}: {
  toolboxes: ToolboxConfig[];
  selected: Set<string>;
  onToggle: (selector: string) => void;
}) {
  return (
    <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
      {toolboxes.map((toolbox) => {
        const selector = toolboxSelector(toolbox);
        const isSelected = toolbox.autoInject || selected.has(selector);
        const locked = toolbox.autoInject;
        return (
          <Card
            key={selector}
            className={cn(
              "transition-colors",
              locked ? "opacity-70" : "cursor-pointer hover:border-primary/60",
              isSelected && !locked && "border-primary ring-1 ring-primary",
            )}
            onClick={locked ? undefined : () => onToggle(selector)}
          >
            <CardContent className="flex flex-col gap-2 p-3">
              <div className="flex items-center gap-2">
                <Checkbox
                  checked={isSelected}
                  disabled={locked}
                  onChange={() => onToggle(selector)}
                  onClick={(e) => e.stopPropagation()}
                />
                <span className="truncate font-medium text-sm">
                  {toolbox.slug}
                </span>
                <div className="ml-auto flex items-center gap-1">
                  {toolbox.autoInject ? (
                    <Badge variant="secondary">always on</Badge>
                  ) : null}
                  {toolbox.harness ? (
                    <Badge variant="outline">harness: {toolbox.harness}</Badge>
                  ) : null}
                  {toolbox.processes && toolbox.processes.length > 0 ? (
                    <Badge variant="outline">
                      runs: {toolbox.processes.map((p) => p.name).join(", ")}
                    </Badge>
                  ) : null}
                </div>
              </div>
              {toolbox.description ? (
                <span className="truncate text-xs text-muted-foreground">
                  {toolbox.description}
                </span>
              ) : null}
            </CardContent>
          </Card>
        );
      })}
    </div>
  );
}
