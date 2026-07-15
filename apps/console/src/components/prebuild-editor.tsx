import type { PrebuildRepo, PrebuildSpec, Source } from "@atelier/spec";
import { useNavigate } from "@tanstack/react-router";
import { Hammer, Loader2, Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { useRunPrebuild } from "@/api/queries/prebuilds";
import { ImageSourcePicker } from "@/components/image-source-picker";
import {
  type SpecEditorApi,
  SpecEditorShell,
} from "@/components/spec-editor-shell";
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
import { parsePrebuildSpec } from "@/lib/spec";

function linesToArray(text: string): string[] {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

function arrayToLines(values: string[] | undefined): string {
  return (values ?? []).join("\n");
}

/** `git@host:org/repo.git` or `https://host/org/repo(.git)?` → `repo`. Best
 * effort only — the smart clonePath default, never a hard requirement (the
 * user can always type over it). */
function repoNameFromUrl(url: string): string {
  const trimmed = url.trim().replace(/\/+$/, "");
  if (!trimmed) return "";
  const lastSegment = trimmed.split(/[/:]/).pop() ?? "";
  return lastSegment.replace(/\.git$/i, "");
}

const EMPTY_SPEC: PrebuildSpec = { source: { image: "" } };

/** The image or snapshot ref a source points at (empty until picked). */
function sourceRef(source: Source): string {
  return "snapshot" in source ? source.snapshot : source.image;
}

const JSON_PLACEHOLDER = `{
  "source": { "image": "dev-base-v2" },
  "repos": [{ "url": "https://github.com/org/repo", "branch": "main", "clonePath": "workspace/repo" }],
  "build": ["cd workspace/repo && bun install"]
}`;

/**
 * Visual↔JSON editor for a `PrebuildSpec`. JSON is the source of truth (via
 * `SpecEditorShell`); the visual form covers the 80% case (source, repos,
 * build) while `env`/`files`/`metadata` stay JSON-only — round-trippable
 * through the shell's toggle, just without a dedicated visual sub-form (they
 * are rarer, free-shaped inputs not worth a bespoke UI yet).
 *
 * `spec` seeds edit mode (a prebuild record replay); omitted for create.
 * Running always re-runs the *current* spec — content-addressing makes an
 * unchanged edit an instant cache hit, so there is no separate "update"
 * action, just "Run prebuild" (`force` set when editing an existing ref, to
 * bypass any stale cache short-circuit on identical content).
 */
export function PrebuildEditor({ spec: initialSpec }: { spec?: PrebuildSpec }) {
  const navigate = useNavigate();
  const runPrebuild = useRunPrebuild();
  const [spec, setSpec] = useState<PrebuildSpec>(initialSpec ?? EMPTY_SPEC);
  const isEditing = initialSpec !== undefined;

  function handleRun(api: SpecEditorApi<PrebuildSpec>) {
    const value = api.resolve();
    if (!value) return;
    if (!sourceRef(value.source).trim()) {
      toast.error("Pick a base image or chain a prebuild snapshot.");
      return;
    }
    // Drop half-typed repo rows (a blank url is meaningless) before running.
    const repos = value.repos?.filter((repo) => repo.url.trim());
    const cleaned: PrebuildSpec = {
      ...value,
      repos: repos && repos.length > 0 ? repos : undefined,
    };
    runPrebuild.mutate(
      { spec: cleaned, force: isEditing },
      {
        onSuccess: () => {
          navigate({ to: "/settings/prebuilds" });
        },
      },
    );
  }

  return (
    <SpecEditorShell
      spec={spec}
      onSpecChange={setSpec}
      parse={parsePrebuildSpec}
      jsonPlaceholder={JSON_PLACEHOLDER}
      renderVisual={(current, onChange) => (
        <PrebuildVisualForm spec={current} onChange={onChange} />
      )}
      footer={(api) => (
        <Button disabled={runPrebuild.isPending} onClick={() => handleRun(api)}>
          {runPrebuild.isPending ? (
            <Loader2 className="animate-spin" />
          ) : (
            <Hammer />
          )}
          Run prebuild
        </Button>
      )}
    />
  );
}

function PrebuildVisualForm({
  spec,
  onChange,
}: {
  spec: PrebuildSpec;
  onChange: (spec: PrebuildSpec) => void;
}) {
  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Source</CardTitle>
          <CardDescription>
            Boot from a base image, or chain onto an existing prebuild snapshot.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <ImageSourcePicker
            value={spec.source}
            onChange={(source) => onChange({ ...spec, source })}
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Repos</CardTitle>
          <CardDescription>
            Cloned before <code>build[]</code> runs. Each clone path defaults to
            the repo name.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <ReposField
            repos={spec.repos}
            onChange={(repos) =>
              onChange({
                ...spec,
                repos: repos.length > 0 ? repos : undefined,
              })
            }
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Build</CardTitle>
          <CardDescription>
            Ordered, fail-fast shell steps baked into the snapshot.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-1">
          <Label htmlFor="prebuild-build">Build steps (one per line)</Label>
          <textarea
            id="prebuild-build"
            value={arrayToLines(spec.build)}
            onChange={(e) => {
              const build = linesToArray(e.target.value);
              onChange({
                ...spec,
                build: build.length > 0 ? build : undefined,
              });
            }}
            spellCheck={false}
            placeholder="cd workspace/repo && bun install"
            className="min-h-32 w-full rounded-md border bg-muted/30 p-2 font-mono text-xs"
          />
        </CardContent>
      </Card>

      <p className="text-xs text-muted-foreground">
        <code>env</code>, <code>files</code> and <code>metadata</code> are
        available in the JSON editor above.
      </p>
    </div>
  );
}

function ReposField({
  repos,
  onChange,
}: {
  repos: PrebuildRepo[] | undefined;
  onChange: (repos: PrebuildRepo[]) => void;
}) {
  // `repos` (from a visual edit or a JSON→visual switch) is the single source
  // of truth — no local row state to keep in sync.
  const rows = repos ?? [];

  function commit(nextRows: PrebuildRepo[]) {
    onChange(
      nextRows.map((repo) => {
        const branch = repo.branch?.trim();
        return { ...repo, branch: branch ? branch : undefined };
      }),
    );
  }

  function updateRow(index: number, patch: Partial<PrebuildRepo>) {
    commit(rows.map((row, i) => (i === index ? { ...row, ...patch } : row)));
  }

  function updateUrl(index: number, url: string) {
    const row = rows[index];
    if (!row) return;
    // Keep auto-filling the clone path from the repo name until the user
    // types one that diverges from the derived default — no dirty flag needed,
    // the comparison is stateless and survives every re-render.
    const shouldAutoFill = row.clonePath === repoNameFromUrl(row.url);
    updateRow(index, {
      url,
      clonePath: shouldAutoFill ? repoNameFromUrl(url) : row.clonePath,
    });
  }

  function addRow() {
    commit([...rows, { url: "", branch: "", clonePath: "" }]);
  }

  function removeRow(index: number) {
    commit(rows.filter((_, i) => i !== index));
  }

  return (
    <div className="space-y-3">
      {rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">No repos yet.</p>
      ) : (
        rows.map((row, index) => (
          <div
            // biome-ignore lint/suspicious/noArrayIndexKey: rows have no stable id; reordering isn't supported
            key={index}
            className="flex flex-col gap-2 rounded-md border p-3 sm:flex-row sm:items-end"
          >
            <div className="flex-1 space-y-1">
              <Label htmlFor={`repo-url-${index}`}>URL</Label>
              <Input
                id={`repo-url-${index}`}
                value={row.url}
                onChange={(e) => updateUrl(index, e.target.value)}
                placeholder="https://github.com/org/repo"
                className="font-mono"
              />
            </div>
            <div className="space-y-1 sm:w-32">
              <Label htmlFor={`repo-branch-${index}`}>Branch</Label>
              <Input
                id={`repo-branch-${index}`}
                value={row.branch ?? ""}
                onChange={(e) => updateRow(index, { branch: e.target.value })}
                placeholder="main"
                className="font-mono"
              />
            </div>
            <div className="space-y-1 sm:w-48">
              <Label htmlFor={`repo-clonepath-${index}`}>Clone path</Label>
              <Input
                id={`repo-clonepath-${index}`}
                value={row.clonePath}
                onChange={(e) =>
                  updateRow(index, { clonePath: e.target.value })
                }
                placeholder="repo-name"
                className="font-mono"
              />
            </div>
            <Button
              type="button"
              variant="outline"
              size="icon"
              onClick={() => removeRow(index)}
              aria-label="Remove repo"
            >
              <Trash2 />
            </Button>
          </div>
        ))
      )}
      <Button type="button" variant="outline" size="sm" onClick={addRow}>
        <Plus />
        Add repo
      </Button>
    </div>
  );
}
