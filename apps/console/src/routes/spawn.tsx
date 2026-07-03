import type { SandboxSpec } from "@atelier/spec";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { Loader2, Rocket, Trash2 } from "lucide-react";
import { type FormEvent, useState } from "react";
import { useSpawnSandbox } from "@/api/queries/sandboxes";
import {
  savedSpecsListQuery,
  useCreateSavedSpec,
  useDeleteSavedSpec,
  useUpdateSavedSpec,
} from "@/api/queries/saved-specs";
import { toolsetsListQuery } from "@/api/queries/toolsets";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
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

  function spawnFromSpec(spec: SandboxSpec) {
    spawn.mutate(spec, {
      onSuccess: (data) => {
        if (data)
          navigate({
            to: "/sandboxes/$sandboxId",
            params: { sandboxId: data.id },
          });
      },
    });
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

      <SavedSpecsSection
        onSpawn={spawnFromSpec}
        spawnPending={spawn.isPending}
        onEdit={(savedSpec) => loadIntoEditor(savedSpec.spec, savedSpec)}
        onDeleted={(id) => {
          if (editingSpec?.id === id) setEditingSpec(null);
        }}
      />

      <ComposeSection
        onSpawn={spawnFromSpec}
        spawnPending={spawn.isPending}
        onOpenInEditor={(spec) => loadIntoEditor(spec)}
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

// ── saved specs ──────────────────────────────────────────────────────────

interface SavedSpecRow {
  id: string;
  orgId?: string;
  name: string;
  spec: SandboxSpec;
  updatedAt: string;
}

function SavedSpecsSection({
  onSpawn,
  spawnPending,
  onEdit,
  onDeleted,
}: {
  onSpawn: (spec: SandboxSpec) => void;
  spawnPending: boolean;
  onEdit: (savedSpec: SavedSpecRow) => void;
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
  savedSpec: SavedSpecRow;
  onSpawn: (spec: SandboxSpec) => void;
  spawnPending: boolean;
  onEdit: (savedSpec: SavedSpecRow) => void;
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

// ── compose ──────────────────────────────────────────────────────────────

function ComposeSection({
  onSpawn,
  spawnPending,
  onOpenInEditor,
}: {
  onSpawn: (spec: SandboxSpec) => void;
  spawnPending: boolean;
  onOpenInEditor: (spec: SandboxSpec) => void;
}) {
  const [form, setForm] = useState({
    harness: true,
    vscode: false,
    terminal: false,
    browser: false,
    image: "dev-base:latest",
    vcpus: "2",
    memoryMb: "2048",
  });
  const [selectedToolsets, setSelectedToolsets] = useState<Set<string>>(
    new Set(),
  );
  const { data: toolsets } = useQuery(toolsetsListQuery());

  function set<K extends keyof typeof form>(key: K, value: (typeof form)[K]) {
    setForm((current) => ({ ...current, [key]: value }));
  }

  function toggleToolset(ref: string) {
    setSelectedToolsets((current) => {
      const next = new Set(current);
      if (next.has(ref)) next.delete(ref);
      else next.add(ref);
      return next;
    });
  }

  function buildSpec(): SandboxSpec {
    const spec = composeSpec({
      harness: form.harness,
      presets: {
        vscode: form.vscode,
        terminal: form.terminal,
        browser: form.browser,
      },
      image: form.image,
      vcpus: Math.max(1, Math.round(Number(form.vcpus) || 1)),
      memoryMb: Math.max(256, Math.round(Number(form.memoryMb) || 256)),
    });
    if (selectedToolsets.size === 0) return spec;
    return { ...spec, toolsets: [...selectedToolsets].map((ref) => ({ ref })) };
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Compose</CardTitle>
        <CardDescription>
          Build a spec from presets — no editing required.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <div className="space-y-1">
            <Label htmlFor="compose-image">Image</Label>
            <Input
              id="compose-image"
              value={form.image}
              onChange={(e) => set("image", e.target.value)}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="compose-vcpus">vCPUs</Label>
            <Input
              id="compose-vcpus"
              type="number"
              min={1}
              value={form.vcpus}
              onChange={(e) => set("vcpus", e.target.value)}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="compose-memory">Memory (MB)</Label>
            <Input
              id="compose-memory"
              type="number"
              min={256}
              value={form.memoryMb}
              onChange={(e) => set("memoryMb", e.target.value)}
            />
          </div>
        </div>
        <div className="flex flex-wrap gap-4">
          {(
            [
              ["harness", "opencode harness"],
              ["vscode", "vscode"],
              ["terminal", "terminal"],
              ["browser", "browser"],
            ] as const
          ).map(([key, label]) => (
            <label
              key={key}
              htmlFor={`compose-${key}`}
              className="flex items-center gap-2 text-sm"
            >
              <Checkbox
                id={`compose-${key}`}
                checked={form[key]}
                onChange={(e) => set(key, e.target.checked)}
              />
              {label}
            </label>
          ))}
        </div>
        {toolsets && toolsets.length > 0 ? (
          <div className="space-y-1">
            <Label>Toolsets</Label>
            <div className="flex flex-wrap gap-4">
              {toolsets.map((toolset) => (
                <label
                  key={toolset.ref}
                  htmlFor={`toolset-${toolset.ref}`}
                  className="flex items-center gap-2 text-sm"
                >
                  <Checkbox
                    id={`toolset-${toolset.ref}`}
                    checked={selectedToolsets.has(toolset.ref)}
                    onChange={() => toggleToolset(toolset.ref)}
                  />
                  {toolset.name}
                </label>
              ))}
            </div>
          </div>
        ) : null}
        <div className="flex flex-wrap gap-2">
          <Button disabled={spawnPending} onClick={() => onSpawn(buildSpec())}>
            {spawnPending ? <Loader2 className="animate-spin" /> : <Rocket />}
            Spawn
          </Button>
          <Button variant="outline" onClick={() => onOpenInEditor(buildSpec())}>
            Open in editor
          </Button>
        </div>
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
  editingSpec,
  onStopEditing,
}: {
  text: string;
  onTextChange: (text: string) => void;
  onSpawn: (spec: SandboxSpec) => void;
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
          <p className="text-sm text-green-500">Valid SandboxSpec</p>
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
