import type {
  CreateSandboxRequest,
  PrebuildRecord,
  SandboxSpec,
} from "@atelier/spec";
import { useQueries, useQuery } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { ChevronDown, Layers, Loader2, Rocket } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { organizationsListQuery } from "@/api/queries/organizations";
import { prebuildsListQuery } from "@/api/queries/prebuilds";
import { useSpawnSandbox } from "@/api/queries/sandboxes";
import { toolboxesListQuery } from "@/api/queries/toolboxes";
import { ToolboxPicker } from "@/components/toolbox-picker";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { composeSpec, parseSpecJsonc, validateSandboxSpec } from "@/lib/spec";

export const Route = createFileRoute("/spawn")({
  component: SpawnPage,
});

function SpawnPage() {
  const navigate = useNavigate();
  const spawn = useSpawnSandbox();
  const [editorText, setEditorText] = useState("");

  // `toolboxes` is optional: the builder-lens callers pass a plain spec plus
  // `toolboxes` as the second arg; it carries through the `...request` spread.
  function spawnFromSpec(request: CreateSandboxRequest, toolboxes?: string[]) {
    spawn.mutate(
      {
        ...request,
        ...(toolboxes && toolboxes.length > 0 ? { toolboxes } : {}),
      },
      {
        // `data` is the 202 `sandbox-create` job; its pre-allocated
        // `metadata.sandboxId` lets us jump straight to the detail page, which
        // renders the `creating` record and live-updates as the spawn runs.
        onSuccess: (data) => {
          const sandboxId = data?.metadata?.sandboxId;
          if (sandboxId) {
            toast.success("Spawning sandbox…");
            navigate({
              to: "/sandboxes/$sandboxId",
              params: { sandboxId },
            });
          } else {
            // Defensive: the server always sets metadata.sandboxId today, so a
            // missing one is a regression — surface it instead of a silent no-op.
            toast.error("Spawn accepted but no sandbox id was returned");
          }
        },
      },
    );
  }

  function loadIntoEditor(spec: SandboxSpec) {
    setEditorText(JSON.stringify(spec, null, 2));
  }

  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <h1 className="text-xl font-semibold">Spawn a sandbox</h1>

      <QuickSpawnSection
        onSpawn={spawnFromSpec}
        spawnPending={spawn.isPending}
        onOpenInEditor={loadIntoEditor}
      />

      <EditorSection
        text={editorText}
        onTextChange={setEditorText}
        onSpawn={spawnFromSpec}
        spawnPending={spawn.isPending}
      />
    </div>
  );
}

// ── quick spawn (prebuild + toolboxes) ──────────────────────

/** Every toolbox the caller can apply — their own + each org's, flattened. */
function useAllToolboxes() {
  const { data: orgs } = useQuery(organizationsListQuery());
  const owners = ["user", ...(orgs ?? []).map((org) => `org:${org.id}`)];
  const results = useQueries({
    queries: owners.map((owner) => toolboxesListQuery(owner)),
  });
  return results.flatMap((r) => r.data ?? []);
}

/** A short, human label for a prebuild — the first cloned repo when present. */
function prebuildLabel(prebuild: PrebuildRecord): string | undefined {
  return prebuild.spec?.repos?.[0]?.url;
}

/** One-tap spawn from a stored prebuild snapshot, with optional harness and a
 * shared toolset selection layered on top (`source.snapshot` + `toolsets`). */
function QuickSpawnSection({
  onSpawn,
  spawnPending,
  onOpenInEditor,
}: {
  onSpawn: (request: CreateSandboxRequest, toolboxes?: string[]) => void;
  spawnPending: boolean;
  onOpenInEditor: (spec: SandboxSpec) => void;
}) {
  const {
    data: prebuilds,
    isPending,
    isError,
    error,
  } = useQuery(prebuildsListQuery());
  const toolboxes = useAllToolboxes();
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [advanced, setAdvanced] = useState({
    vcpus: "2",
    memoryMb: "2048",
  });
  const [selectedToolboxes, setSelectedToolboxes] = useState<Set<string>>(
    new Set(),
  );

  function setAdv<K extends keyof typeof advanced>(
    key: K,
    value: (typeof advanced)[K],
  ) {
    setAdvanced((current) => ({ ...current, [key]: value }));
  }

  function toggleToolbox(selector: string) {
    setSelectedToolboxes((current) => {
      const next = new Set(current);
      if (next.has(selector)) next.delete(selector);
      else next.add(selector);
      return next;
    });
  }

  function buildSpec(snapshotRef: string): SandboxSpec {
    // No harness or tool presets here: the harness AND any tool surfaces
    // (vscode, browser, …) come from the toolboxes applied to the spawn,
    // never hardcoded UI toggles.
    const base = composeSpec({
      image: "unused",
      vcpus: Math.max(1, Math.round(Number(advanced.vcpus) || 1)),
      memoryMb: Math.max(256, Math.round(Number(advanced.memoryMb) || 256)),
    });
    return { ...base, source: { snapshot: snapshotRef } };
  }

  const pickedToolboxes = () => [...selectedToolboxes];

  return (
    <Card>
      <CardHeader>
        <CardTitle>Quick spawn from a prebuild</CardTitle>
        <CardDescription>
          Boot straight from a workspace snapshot, with toolsets layered on top.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex flex-wrap items-center gap-4">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="ml-auto"
            onClick={() => setAdvancedOpen((open) => !open)}
          >
            <ChevronDown
              className={
                advancedOpen
                  ? "rotate-180 transition-transform"
                  : "transition-transform"
              }
            />
            Advanced
          </Button>
        </div>
        {advancedOpen ? (
          <div className="space-y-3 rounded-md border bg-muted/20 p-3">
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div className="space-y-1">
                <Label htmlFor="quick-vcpus">vCPUs</Label>
                <Input
                  id="quick-vcpus"
                  type="number"
                  min={1}
                  value={advanced.vcpus}
                  onChange={(e) => setAdv("vcpus", e.target.value)}
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="quick-memory">Memory (MB)</Label>
                <Input
                  id="quick-memory"
                  type="number"
                  min={256}
                  value={advanced.memoryMb}
                  onChange={(e) => setAdv("memoryMb", e.target.value)}
                />
              </div>
            </div>
          </div>
        ) : null}
        {toolboxes.length > 0 ? (
          <div className="space-y-1">
            <Label>Toolboxes</Label>
            <ToolboxPicker
              toolboxes={toolboxes}
              selected={selectedToolboxes}
              onToggle={toggleToolbox}
            />
          </div>
        ) : null}
        {isPending ? (
          <div className="space-y-2">
            <Skeleton className="h-14 w-full" />
            <Skeleton className="h-14 w-full" />
          </div>
        ) : isError ? (
          <p className="text-sm text-destructive">
            {error instanceof Error ? error.message : "Failed to load"}
          </p>
        ) : !prebuilds || prebuilds.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No prebuilds yet. Create one under Settings → Prebuilds.
          </p>
        ) : (
          <div className="space-y-2">
            {prebuilds.map((prebuild: PrebuildRecord) => {
              const label = prebuildLabel(prebuild);
              return (
                <div
                  key={prebuild.ref}
                  className="flex flex-col gap-2 rounded-md border p-3 sm:flex-row sm:items-center sm:justify-between"
                >
                  <div className="flex min-w-0 flex-col gap-0.5">
                    <div className="flex flex-wrap items-center gap-2">
                      <Layers className="size-4 shrink-0 text-muted-foreground" />
                      <span className="truncate font-medium">
                        {label ?? prebuild.ref}
                      </span>
                      {prebuild.parent ? (
                        <Badge variant="outline">chained</Badge>
                      ) : null}
                    </div>
                    <span className="truncate font-mono text-xs text-muted-foreground">
                      {prebuild.ref}
                    </span>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    <Button
                      size="sm"
                      disabled={spawnPending}
                      onClick={() =>
                        onSpawn(buildSpec(prebuild.ref), pickedToolboxes())
                      }
                    >
                      {spawnPending ? (
                        <Loader2 className="animate-spin" />
                      ) : (
                        <Rocket />
                      )}
                      Spawn
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => onOpenInEditor(buildSpec(prebuild.ref))}
                    >
                      Editor
                    </Button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ── editor ───────────────────────────────────────────────────────────────

function EditorSection({
  text,
  onTextChange,
  onSpawn,
  spawnPending,
}: {
  text: string;
  onTextChange: (text: string) => void;
  onSpawn: (request: CreateSandboxRequest) => void;
  spawnPending: boolean;
}) {
  const [errors, setErrors] = useState<string[]>([]);
  const [validated, setValidated] = useState(false);

  function validate(): SandboxSpec | undefined {
    const parsed = parseSpecJsonc(text);
    if (!parsed.ok) {
      setErrors(parsed.errors);
      setValidated(false);
      return undefined;
    }
    const result = validateSandboxSpec(parsed.value);
    if (!result.ok) {
      setErrors(result.errors);
      setValidated(false);
      return undefined;
    }
    setErrors([]);
    setValidated(true);
    return result.spec;
  }

  function handleSpawn() {
    const spec = validate();
    if (spec) onSpawn(spec);
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Editor</CardTitle>
        <CardDescription>Edit the spec directly as JSONC.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <textarea
          value={text}
          onChange={(e) => {
            onTextChange(e.target.value);
            setValidated(false);
            setErrors([]);
          }}
          spellCheck={false}
          className="min-h-64 w-full rounded-md border bg-muted/30 p-3 font-mono text-xs"
          placeholder='{"source": {"image": "dev-base:latest"}, "resources": {"vcpus": 2, "memoryMb": 2048}}'
        />
        {errors.length > 0 ? (
          <ul className="space-y-1 text-sm text-destructive">
            {errors.map((message, index) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: messages can repeat; list resets wholesale on each validate
              <li key={index}>{message}</li>
            ))}
          </ul>
        ) : validated ? (
          <p className="text-sm text-success">Valid SandboxSpec</p>
        ) : null}
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" onClick={validate}>
            Validate
          </Button>
          <Button disabled={spawnPending} onClick={handleSpawn}>
            {spawnPending ? <Loader2 className="animate-spin" /> : <Rocket />}
            Spawn
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
