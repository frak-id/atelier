import type { SandboxSpec, TemplateMeta } from "@atelier/spec";
import { useQuery } from "@tanstack/react-query";
import { LayoutGrid, Rocket } from "lucide-react";
import { useState } from "react";
import { savedSpecsListQuery } from "@/api/queries/saved-specs";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { harnessFromAnnotations } from "@/lib/sandbox-status";
import { applyRepoUrlParam } from "@/lib/templates";

/**
 * The template gallery — published saved specs (`template: true`), rendered
 * as one-tap cards (design ui-evolution.md §2). A "template" is an org/user
 * asset, not static data: what appears here reflects whichever harnesses and
 * toolboxes the org has actually baked into its saved specs. Operator lens
 * sees exactly this gallery and nothing else; Builder lens sees it alongside
 * prebuilds/saved-specs/editor (see routes/spawn.tsx).
 */
export function TemplateGallery({
  onSpawn,
  spawning,
}: {
  onSpawn: (spec: SandboxSpec) => void;
  spawning: boolean;
}) {
  const {
    data: savedSpecs,
    isPending,
    isError,
    error,
  } = useQuery(savedSpecsListQuery());
  const templates = (savedSpecs ?? []).filter((s) => s.template);
  // Tracks which card's Spawn was clicked so only that card shows a spinner
  // while the (single, shared) spawn mutation is in flight.
  const [activeId, setActiveId] = useState<string | null>(null);

  if (isPending) {
    return (
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <Skeleton className="h-40 w-full" />
        <Skeleton className="h-40 w-full" />
        <Skeleton className="h-40 w-full" />
      </div>
    );
  }

  if (isError) {
    return (
      <p className="text-sm text-destructive">
        {error instanceof Error ? error.message : "Failed to load templates"}
      </p>
    );
  }

  if (templates.length === 0) {
    return (
      <EmptyState
        icon={LayoutGrid}
        title="No templates published yet"
        description='An admin can publish a saved spec from Settings → Templates, or "Save as template" from the editor.'
      />
    );
  }

  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
      {templates.map((template) => (
        <TemplateCard
          key={template.id}
          template={template}
          spawning={spawning && activeId === template.id}
          disabled={spawning}
          onSpawn={(spec) => {
            setActiveId(template.id);
            onSpawn(spec);
          }}
        />
      ))}
    </div>
  );
}

interface GalleryTemplate {
  id: string;
  name: string;
  spec: SandboxSpec;
  meta?: TemplateMeta | null;
}

function TemplateCard({
  template,
  onSpawn,
  spawning,
  disabled,
}: {
  template: GalleryTemplate;
  onSpawn: (spec: SandboxSpec) => void;
  spawning: boolean;
  disabled: boolean;
}) {
  const harness = harnessFromAnnotations(template.spec.annotations);
  const params = template.meta?.params ?? [];
  const [values, setValues] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);

  const missingRequired = params.some(
    (p) => p.required && (values[p.key] ?? "").trim() === "",
  );

  function handleSpawn() {
    let spec = template.spec;
    try {
      for (const param of params) {
        const value = (values[param.key] ?? "").trim();
        if (!value) continue;
        if (param.kind === "repo-url") {
          spec = applyRepoUrlParam(spec, value);
        } else {
          // Exhaustiveness: adding a new param kind must be handled here.
          param.kind satisfies "string";
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Invalid parameter value");
      return;
    }
    setError(null);
    onSpawn(spec);
  }

  return (
    <Card className="flex flex-col">
      <CardContent className="flex flex-1 flex-col gap-3 p-4">
        <div className="min-w-0">
          <p className="font-medium">{template.name}</p>
          {harness ? (
            <div className="flex flex-wrap gap-1 pt-0.5">
              <Badge variant="neutral">{harness}</Badge>
            </div>
          ) : null}
        </div>
        {template.meta?.description ? (
          <p className="flex-1 text-sm text-muted-foreground">
            {template.meta.description}
          </p>
        ) : (
          <div className="flex-1" />
        )}
        {params.map((param) => (
          <Input
            key={param.key}
            value={values[param.key] ?? ""}
            onChange={(e) =>
              setValues((current) => ({
                ...current,
                [param.key]: e.target.value,
              }))
            }
            placeholder={
              param.hint ??
              (param.kind === "repo-url"
                ? "https://github.com/org/repo"
                : param.label)
            }
            aria-label={param.label}
          />
        ))}
        {error ? <p className="text-xs text-destructive">{error}</p> : null}
        <Button
          size="sm"
          loading={spawning}
          disabled={disabled || missingRequired}
          onClick={handleSpawn}
        >
          <Rocket />
          Spawn
        </Button>
      </CardContent>
    </Card>
  );
}
