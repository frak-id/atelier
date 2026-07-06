import type { CreateSandboxRequest, ToolboxConfig } from "@atelier/spec";
import { Rocket } from "lucide-react";
import { useState } from "react";
import { toolboxSelector } from "@/components/toolbox-picker";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  ALL_TEMPLATES,
  OPERATOR_DEFAULT_IDS,
  type Template,
  templateToRequest,
  withRepoClone,
} from "@/lib/templates";
import { useLens } from "@/providers/lens";

/**
 * The template gallery — the primary on-ramp for a non-technical user
 * (IMPLEMENTATION_PLAN.md §5.1). Operator lens shows only the top-3
 * lowest-friction cards; Builder lens shows the full grid (core + extras).
 * `toolboxes` are the caller's available toolboxes, used only to resolve a
 * `requiresToolbox` template (e.g. Pi Agent needs the user's own `pi`
 * toolbox) — the gallery never creates one on the caller's behalf.
 */
export function TemplateGallery({
  toolboxes,
  onSpawn,
  spawning,
}: {
  toolboxes: ToolboxConfig[];
  onSpawn: (request: CreateSandboxRequest) => void;
  spawning: boolean;
}) {
  const { lens } = useLens();
  const templates =
    lens === "operator"
      ? ALL_TEMPLATES.filter((t) => OPERATOR_DEFAULT_IDS.includes(t.id))
      : ALL_TEMPLATES;
  // Tracks which card's Spawn was clicked so only that card shows a spinner
  // while the (single, shared) spawn mutation is in flight.
  const [activeTemplateId, setActiveTemplateId] = useState<string | null>(null);

  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
      {templates.map((template) => (
        <TemplateCard
          key={template.id}
          template={template}
          toolboxes={toolboxes}
          spawning={spawning && activeTemplateId === template.id}
          disabled={spawning}
          onSpawn={(request) => {
            setActiveTemplateId(template.id);
            onSpawn(request);
          }}
        />
      ))}
    </div>
  );
}

function TemplateCard({
  template,
  toolboxes,
  onSpawn,
  spawning,
  disabled,
}: {
  template: Template;
  toolboxes: ToolboxConfig[];
  onSpawn: (request: CreateSandboxRequest) => void;
  spawning: boolean;
  disabled: boolean;
}) {
  const Icon = template.icon;

  const [repoUrl, setRepoUrl] = useState("");
  const requiredToolbox = template.requiresToolbox
    ? toolboxes.find((t) => t.slug === template.requiresToolbox)
    : undefined;
  const missingToolbox = Boolean(template.requiresToolbox) && !requiredToolbox;
  const missingRepoUrl =
    Boolean(template.needsRepoUrl) && repoUrl.trim() === "";

  function handleSpawn() {
    const selectors = requiredToolbox ? [toolboxSelector(requiredToolbox)] : [];
    const resolved = template.needsRepoUrl
      ? withRepoClone(template, repoUrl.trim())
      : template;
    onSpawn(templateToRequest(resolved, selectors));
  }

  return (
    <Card className="flex flex-col">
      <CardContent className="flex flex-1 flex-col gap-3 p-4">
        <div className="flex items-start gap-3">
          <div className="flex size-9 shrink-0 items-center justify-center rounded-md bg-muted">
            <Icon className="size-4.5 text-foreground" />
          </div>
          <div className="min-w-0">
            <p className="font-medium">{template.name}</p>
            <div className="flex flex-wrap gap-1 pt-0.5">
              {(template.surfaces ?? []).map((surface) => (
                <Badge key={surface} variant="neutral">
                  {surface}
                </Badge>
              ))}
            </div>
          </div>
        </div>
        <p className="flex-1 text-sm text-muted-foreground">
          {template.description}
        </p>
        {missingToolbox ? (
          <p className="text-xs text-warning">
            Needs your “{template.requiresToolbox}” toolbox — create it under
            Settings → Toolboxes first.
          </p>
        ) : null}
        {template.needsRepoUrl ? (
          <Input
            value={repoUrl}
            onChange={(e) => setRepoUrl(e.target.value)}
            placeholder="https://github.com/org/repo"
            aria-label="Repository URL"
          />
        ) : null}
        <Button
          size="sm"
          loading={spawning}
          disabled={disabled || missingToolbox || missingRepoUrl}
          onClick={handleSpawn}
        >
          <Rocket />
          Spawn
        </Button>
      </CardContent>
    </Card>
  );
}
