import type {
  CreateSandboxRequest,
  PrebuildRecord,
  SandboxSpec,
} from "@atelier/spec";
import { useQueries, useQuery } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { ChevronDown, Layers, Loader2, Rocket, Trash2 } from "lucide-react";
import { type FormEvent, useState } from "react";
import { toast } from "sonner";
import { organizationsListQuery } from "@/api/queries/organizations";
import { prebuildsListQuery } from "@/api/queries/prebuilds";
import { useSpawnSandbox } from "@/api/queries/sandboxes";
import {
  type SavedSpec,
  savedSpecsListQuery,
  useCreateSavedSpec,
  useDeleteSavedSpec,
  useUpdateSavedSpec,
} from "@/api/queries/saved-specs";
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
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { formatRelativeTime } from "@/lib/formatters";
import { composeSpec, parseSpecJsonc, validateSandboxSpec } from "@/lib/spec";

export const Route = createFileRoute("/spawn")({
  component: SpawnPage,
});

function SpawnPage() {
  const navigate = useNavigate();
  const spawn = useSpawnSandbox();
  const [editorText, setEditorText] = useState("");
  const [editingSpec, setEditingSpec] = useState<{
    id: string;
    name: string;
  } | null>(null);

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
          }
        },
      },
    );
  }

  function loadIntoEditor(
    spec: SandboxSpec,
    savedSpec?: { id: string; name: string },
  ) {
    setEditorText(JSON.stringify(spec, null, 2));
    setEditingSpec(savedSpec ?? null);
  }

  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <h1 className="text-xl font-semibold">Spawn a sandbox</h1>

      <QuickSpawnSection
        onSpawn={spawnFromSpec}
        spawnPending={spawn.isPending}
        onOpenInEditor={(spec) => loadIntoEditor(spec)}
      />

      <SavedSpecsSection
        onSpawn={spawnFromSpec}
        spawnPending={spawn.isPending}
        onEdit={(savedSpec) => loadIntoEditor(savedSpec.spec, savedSpec)}
        onDeleted={(id) => {
          if (editingSpec?.id === id) setEditingSpec(null);
        }}
      />

      <EditorSection
        text={editorText}
        onTextChange={setEditorText}
        onSpawn={spawnFromSpec}
        spawnPending={spawn.isPending}
        editingSpec={editingSpec}
        onStopEditing={() => setEditingSpec(null)}
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

/** Short, human summary of a prebuild's opaque metadata (workspace/repo…). */
function metadataSummary(metadata?: Record<string, string>): string | null {
  if (!metadata) return null;
  const entries = Object.entries(metadata);
  if (entries.length === 0) return null;
  return entries.map(([k, v]) => `${k}: ${v}`).join(" · ");
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
              const summary = metadataSummary(prebuild.metadata);
              return (
                <div
                  key={prebuild.ref}
                  className="flex flex-col gap-2 rounded-md border p-3 sm:flex-row sm:items-center sm:justify-between"
                >
                  <div className="flex min-w-0 flex-col gap-0.5">
                    <div className="flex flex-wrap items-center gap-2">
                      <Layers className="size-4 shrink-0 text-muted-foreground" />
                      <span className="truncate font-medium">
                        {summary ?? prebuild.ref}
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

// ── saved specs ──────────────────────────────────────────────────────────

function SavedSpecsSection({
  onSpawn,
  spawnPending,
  onEdit,
  onDeleted,
}: {
  onSpawn: (request: CreateSandboxRequest) => void;
  spawnPending: boolean;
  onEdit: (savedSpec: SavedSpec) => void;
  onDeleted: (id: string) => void;
}) {
  const {
    data: savedSpecs,
    isPending,
    isError,
    error,
  } = useQuery(savedSpecsListQuery());

  return (
    <Card>
      <CardHeader>
        <CardTitle>Saved specs</CardTitle>
        <CardDescription>One-tap spawn from a saved spec.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-2">
        {isPending ? (
          <div className="space-y-2">
            <Skeleton className="h-12 w-full" />
            <Skeleton className="h-12 w-full" />
          </div>
        ) : isError ? (
          <p className="text-sm text-destructive">
            {error instanceof Error ? error.message : "Failed to load"}
          </p>
        ) : !savedSpecs || savedSpecs.length === 0 ? (
          <p className="text-sm text-muted-foreground">No saved specs yet.</p>
        ) : (
          savedSpecs.map((savedSpec) => (
            <SavedSpecItem
              key={savedSpec.id}
              savedSpec={savedSpec}
              onSpawn={onSpawn}
              spawnPending={spawnPending}
              onEdit={onEdit}
              onDeleted={onDeleted}
            />
          ))
        )}
      </CardContent>
    </Card>
  );
}

function SavedSpecItem({
  savedSpec,
  onSpawn,
  spawnPending,
  onEdit,
  onDeleted,
}: {
  savedSpec: SavedSpec;
  onSpawn: (request: CreateSandboxRequest) => void;
  spawnPending: boolean;
  onEdit: (savedSpec: SavedSpec) => void;
  onDeleted: (id: string) => void;
}) {
  const deleteSpec = useDeleteSavedSpec();
  const [confirmOpen, setConfirmOpen] = useState(false);

  return (
    <div className="flex flex-col gap-2 rounded-md border p-3 sm:flex-row sm:items-center sm:justify-between">
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <span className="truncate font-medium">{savedSpec.name}</span>
        {savedSpec.orgId ? <Badge variant="outline">org</Badge> : null}
        <span className="text-xs text-muted-foreground">
          {formatRelativeTime(savedSpec.updatedAt)}
        </span>
      </div>
      <div className="flex items-center gap-2">
        <Button
          size="sm"
          disabled={spawnPending}
          onClick={() => onSpawn(savedSpec.spec)}
        >
          {spawnPending ? <Loader2 className="animate-spin" /> : <Rocket />}
          Spawn
        </Button>
        <Button variant="outline" size="sm" onClick={() => onEdit(savedSpec)}>
          Edit
        </Button>
        <Button
          variant="outline"
          size="icon"
          disabled={deleteSpec.isPending}
          onClick={() => setConfirmOpen(true)}
          aria-label="Delete saved spec"
        >
          {deleteSpec.isPending ? (
            <Loader2 className="animate-spin" />
          ) : (
            <Trash2 />
          )}
        </Button>
      </div>
      <Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete saved spec?</DialogTitle>
            <DialogDescription>
              This permanently deletes “{savedSpec.name}”. This cannot be
              undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmOpen(false)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                deleteSpec.mutate(savedSpec.id, {
                  onSuccess: () => onDeleted(savedSpec.id),
                });
                setConfirmOpen(false);
              }}
            >
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ── editor ───────────────────────────────────────────────────────────────

function EditorSection({
  text,
  onTextChange,
  onSpawn,
  spawnPending,
  editingSpec,
  onStopEditing,
}: {
  text: string;
  onTextChange: (text: string) => void;
  onSpawn: (request: CreateSandboxRequest) => void;
  spawnPending: boolean;
  editingSpec: { id: string; name: string } | null;
  onStopEditing: () => void;
}) {
  const [errors, setErrors] = useState<string[]>([]);
  const [validated, setValidated] = useState(false);
  const [saveDialogOpen, setSaveDialogOpen] = useState(false);
  const [saveName, setSaveName] = useState("");
  const createSavedSpec = useCreateSavedSpec();
  const updateSavedSpec = useUpdateSavedSpec();

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

  function handleSaveSubmit(event: FormEvent) {
    event.preventDefault();
    const spec = validate();
    if (!spec || !saveName) return;
    createSavedSpec.mutate(
      { name: saveName, spec },
      { onSuccess: () => setSaveDialogOpen(false) },
    );
  }

  function handleUpdate() {
    const spec = validate();
    if (!spec || !editingSpec) return;
    updateSavedSpec.mutate(
      { id: editingSpec.id, spec },
      { onSuccess: onStopEditing },
    );
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
          {editingSpec ? (
            <>
              <Button
                variant="outline"
                disabled={updateSavedSpec.isPending}
                onClick={handleUpdate}
              >
                {updateSavedSpec.isPending ? (
                  <Loader2 className="animate-spin" />
                ) : null}
                Update {editingSpec.name}
              </Button>
              <Button variant="ghost" onClick={onStopEditing}>
                Cancel editing
              </Button>
            </>
          ) : (
            <Button variant="outline" onClick={() => setSaveDialogOpen(true)}>
              Save as…
            </Button>
          )}
        </div>
      </CardContent>
      <Dialog open={saveDialogOpen} onOpenChange={setSaveDialogOpen}>
        <DialogContent>
          <form onSubmit={handleSaveSubmit}>
            <DialogHeader>
              <DialogTitle>Save spec</DialogTitle>
              <DialogDescription>
                Give this spec a name to spawn it one-tap later.
              </DialogDescription>
            </DialogHeader>
            <div className="py-2">
              <Label htmlFor="save-spec-name">Name</Label>
              <Input
                id="save-spec-name"
                value={saveName}
                onChange={(e) => setSaveName(e.target.value)}
                required
                autoFocus
              />
            </div>
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => setSaveDialogOpen(false)}
              >
                Cancel
              </Button>
              <Button type="submit" disabled={createSavedSpec.isPending}>
                {createSavedSpec.isPending ? (
                  <Loader2 className="animate-spin" />
                ) : null}
                Save
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
