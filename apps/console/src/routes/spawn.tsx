import type {
  CreateSandboxRequest,
  PrebuildRecord,
  SandboxSpec,
} from "@atelier/spec";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { ChevronDown, Layers, Loader2, Rocket } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { prebuildsListQuery } from "@/api/queries/prebuilds";
import { useSpawnSandbox } from "@/api/queries/sandboxes";
import { RepoSpawnCard } from "@/components/repos/repo-spawn-card";
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
import { useAllToolboxes } from "@/hooks/use-all-toolboxes";
import { formatRelativeTime, prebuildTitle } from "@/lib/formatters";
import { composeSpec, parseSpecJsonc, validateSandboxSpec } from "@/lib/spec";

interface SpawnSearch {
  /** `owner/name` of a GitHub repo to preselect (deep link). */
  repo?: string;
  /** Non-default branch to preselect. */
  branch?: string;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export const Route = createFileRoute("/spawn")({
  validateSearch: (search: Record<string, unknown>): SpawnSearch => ({
    repo: optionalString(search.repo),
    branch: optionalString(search.branch),
  }),
  component: SpawnPage,
});

function SpawnPage() {
  const navigate = useNavigate();
  const search = Route.useSearch();
  const spawn = useSpawnSandbox();
  const [editorText, setEditorText] = useState("");
  const [resources, setResources] = useState({ vcpus: "2", memoryMb: "4096" });
  const [selectedToolboxes, setSelectedToolboxes] = useState<Set<string>>(
    new Set(),
  );

  /** The spec skeleton every spawn path starts from: the shared resources.
   * The harness and any tool surfaces (vscode, browser, …) come from the
   * toolboxes applied to the spawn, never from hardcoded UI toggles. */
  function baseSpec(image: string): SandboxSpec {
    return composeSpec({
      image,
      vcpus: Math.max(1, Math.round(Number(resources.vcpus) || 1)),
      memoryMb: Math.max(256, Math.round(Number(resources.memoryMb) || 256)),
    });
  }

  /** Spawn with the page's selected toolboxes layered on top. */
  function spawnWithOptions(request: CreateSandboxRequest) {
    const toolboxes = [...selectedToolboxes];
    spawnFromSpec({
      ...request,
      ...(toolboxes.length > 0 ? { toolboxes } : {}),
    });
  }

  function spawnFromSpec(request: CreateSandboxRequest) {
    spawn.mutate(request, {
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
          // missing one is a regression. Surface it, don't silently no-op.
          toast.error("Spawn accepted but no sandbox id was returned");
        }
      },
    });
  }

  function loadIntoEditor(spec: SandboxSpec) {
    setEditorText(JSON.stringify(spec, null, 2));
  }

  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <h1 className="text-xl font-semibold">Spawn a sandbox</h1>

      <RepoSpawnCard
        repo={search.repo}
        branch={search.branch}
        onSelectionChange={(next) =>
          navigate({
            to: "/spawn",
            search: next,
            replace: true,
            // Picking a repo/branch is in-page state, not a page change.
            resetScroll: false,
          })
        }
        baseSpec={baseSpec}
        onSpawn={spawnWithOptions}
        spawnPending={spawn.isPending}
      />

      <SpawnOptionsCard
        resources={resources}
        onResourcesChange={setResources}
        selectedToolboxes={selectedToolboxes}
        onSelectedToolboxesChange={setSelectedToolboxes}
      />

      <PrebuildSpawnSection
        baseSpec={baseSpec}
        onSpawn={spawnWithOptions}
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

// ── shared spawn options (toolboxes + resources) ───────────────────────────

function SpawnOptionsCard({
  resources,
  onResourcesChange,
  selectedToolboxes,
  onSelectedToolboxesChange,
}: {
  resources: { vcpus: string; memoryMb: string };
  onResourcesChange: (next: { vcpus: string; memoryMb: string }) => void;
  selectedToolboxes: Set<string>;
  onSelectedToolboxesChange: (next: Set<string>) => void;
}) {
  const toolboxes = useAllToolboxes();
  const [advancedOpen, setAdvancedOpen] = useState(false);

  function toggleToolbox(selector: string) {
    const next = new Set(selectedToolboxes);
    if (next.has(selector)) next.delete(selector);
    else next.add(selector);
    onSelectedToolboxesChange(next);
  }

  return (
    <Card>
      <CardHeader className="flex-row items-start justify-between gap-3 space-y-0">
        <div className="space-y-1.5">
          <CardTitle className="text-base">Spawn options</CardTitle>
          <CardDescription>
            Applied to every spawn on this page: toolboxes layered on top and
            the sandbox's resources.
          </CardDescription>
        </div>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          aria-expanded={advancedOpen}
          onClick={() => setAdvancedOpen((open) => !open)}
        >
          <ChevronDown
            className={
              advancedOpen
                ? "rotate-180 transition-transform"
                : "transition-transform"
            }
          />
          Resources
          <span className="text-muted-foreground">
            {resources.vcpus} vCPU · {resources.memoryMb} MB
          </span>
        </Button>
      </CardHeader>
      <CardContent className="space-y-4">
        {advancedOpen ? (
          <div className="grid grid-cols-1 gap-3 rounded-md border bg-muted/20 p-3 sm:grid-cols-2">
            <div className="space-y-1">
              <Label htmlFor="spawn-vcpus">vCPUs</Label>
              <Input
                id="spawn-vcpus"
                type="number"
                min={1}
                value={resources.vcpus}
                onChange={(e) =>
                  onResourcesChange({ ...resources, vcpus: e.target.value })
                }
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="spawn-memory">Memory (MB)</Label>
              <Input
                id="spawn-memory"
                type="number"
                min={256}
                value={resources.memoryMb}
                onChange={(e) =>
                  onResourcesChange({ ...resources, memoryMb: e.target.value })
                }
              />
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
        ) : (
          <p className="text-sm text-muted-foreground">
            No toolboxes yet. Add one under Settings → Toolboxes to layer a
            harness or tools onto your sandboxes.
          </p>
        )}
      </CardContent>
    </Card>
  );
}

// ── spawn from a stored prebuild ───────────────────────────────────────────

/** One-tap spawn from ANY stored prebuild snapshot (including hand-written
 * and chained ones the repo card doesn't cover). */
function PrebuildSpawnSection({
  baseSpec,
  onSpawn,
  spawnPending,
  onOpenInEditor,
}: {
  baseSpec: (image: string) => SandboxSpec;
  onSpawn: (request: CreateSandboxRequest) => void;
  spawnPending: boolean;
  onOpenInEditor: (spec: SandboxSpec) => void;
}) {
  const {
    data: prebuilds,
    isPending,
    isError,
    error,
  } = useQuery(prebuildsListQuery());

  function buildSpec(snapshotRef: string): SandboxSpec {
    return { ...baseSpec("unused"), source: { snapshot: snapshotRef } };
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Spawn from a stored prebuild</CardTitle>
        <CardDescription>
          Boot straight from any workspace snapshot, with the options above.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-2">
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
            No prebuilds yet. Pick a repository above, or create one under{" "}
            <Link to="/settings/prebuilds" className="underline">
              Settings → Prebuilds
            </Link>
            .
          </p>
        ) : (
          prebuilds.map((prebuild: PrebuildRecord) => {
            return (
              <div
                key={prebuild.ref}
                className="flex flex-col gap-2 rounded-md border p-3 sm:flex-row sm:items-center sm:justify-between"
              >
                <div className="flex min-w-0 flex-col gap-0.5">
                  <div className="flex flex-wrap items-center gap-2">
                    <Layers className="size-4 shrink-0 text-muted-foreground" />
                    <span className="truncate font-medium">
                      {prebuildTitle(prebuild)}
                    </span>
                    {prebuild.parent ? (
                      <Badge variant="outline">chained</Badge>
                    ) : null}
                    <span className="text-xs text-muted-foreground">
                      {formatRelativeTime(prebuild.createdAt)}
                    </span>
                  </div>
                  <span className="truncate font-mono text-xs text-muted-foreground">
                    {prebuild.ref}
                  </span>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <Button
                    size="sm"
                    disabled={spawnPending}
                    onClick={() => onSpawn(buildSpec(prebuild.ref))}
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
          })
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
