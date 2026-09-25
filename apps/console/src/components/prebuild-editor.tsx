import { type PrebuildSpec, runtimeOnlyEdit, type Source } from "@atelier/spec";
import { useNavigate } from "@tanstack/react-router";
import { Hammer, Loader2, Save } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import {
  useRunPrebuild,
  useSavePrebuildSurface,
} from "@/api/queries/prebuilds";
import { ImageSourcePicker } from "@/components/image-source-picker";
import { ReposField, repoProblems } from "@/components/repos-field";
import { RuntimeSurfaceField } from "@/components/runtime-surface-field";
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
import { Label } from "@/components/ui/label";
import { cloneCwds } from "@/lib/runtime-surface";
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

const EMPTY_SPEC: PrebuildSpec = { source: { image: "" } };

/** The image or snapshot ref a source points at (empty until picked). */
function sourceRef(source: Source): string {
  return "snapshot" in source ? source.snapshot : source.image;
}

const JSON_PLACEHOLDER = `{
  "source": { "image": "dev-base" },
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
 * `spec` + `prebuildRef` seed edit mode (a prebuild record replay); omitted
 * for create. Running re-bakes the *current* spec (`force` when editing, to
 * bypass any stale cache short-circuit on identical content). An edit that
 * only touches the dev servers saves them on the stored prebuild instead
 * (`PATCH …/surface`): no content-key resolution, so it can't turn into a
 * re-bake when a repo got new commits since.
 */
export function PrebuildEditor({
  spec: initialSpec,
  prebuildRef,
}: {
  spec?: PrebuildSpec;
  prebuildRef?: string;
}) {
  const navigate = useNavigate();
  const runPrebuild = useRunPrebuild();
  const saveSurface = useSavePrebuildSurface();
  const isPending = runPrebuild.isPending || saveSurface.isPending;
  const [spec, setSpec] = useState<PrebuildSpec>(initialSpec ?? EMPTY_SPEC);
  const isEditing = initialSpec !== undefined;
  /** Only processes/ports changed: same snapshot, nothing to rebuild. */
  const surfaceOnly = (next: PrebuildSpec) =>
    initialSpec !== undefined &&
    prebuildRef !== undefined &&
    runtimeOnlyEdit(initialSpec, next);
  // The dev-servers form validates locally (names, ports, readiness): block
  // Run while it has a blocking issue.
  const [visualValid, setVisualValid] = useState(true);

  // The footer's label and the run judge the same (cleaned) spec.
  const savesOnly = surfaceOnly(cleanSpec(spec));

  function handleRun(api: SpecEditorApi<PrebuildSpec>) {
    if (api.mode === "visual" && !visualValid) return;
    const value = api.resolve();
    if (!value) return;
    if (!sourceRef(value.source).trim()) {
      toast.error("Pick a base image or chain a prebuild snapshot.");
      return;
    }
    const cleaned = cleanSpec(value);
    const problem = repoProblems(cleaned.repos ?? [])[0];
    if (problem) {
      toast.error(problem);
      return;
    }
    const done = { onSuccess: () => navigate({ to: "/settings/prebuilds" }) };
    if (prebuildRef && surfaceOnly(cleaned)) {
      saveSurface.mutate({ ref: prebuildRef, surface: cleaned }, done);
      return;
    }
    // Editing re-bakes on purpose (force).
    runPrebuild.mutate({ spec: cleaned, force: isEditing }, done);
  }

  return (
    <SpecEditorShell
      spec={spec}
      onSpecChange={setSpec}
      parse={parsePrebuildSpec}
      jsonPlaceholder={JSON_PLACEHOLDER}
      renderVisual={(current, onChange) => (
        <PrebuildVisualForm
          spec={current}
          onChange={onChange}
          onValidityChange={setVisualValid}
        />
      )}
      footer={(api) => (
        <Button
          disabled={isPending || (api.mode === "visual" && !visualValid)}
          onClick={() => handleRun(api)}
        >
          {isPending ? (
            <Loader2 className="animate-spin" />
          ) : savesOnly ? (
            <Save />
          ) : (
            <Hammer />
          )}
          {savesOnly ? "Save (no rebuild)" : "Run prebuild"}
        </Button>
      )}
    />
  );
}

/** Drop half-typed repo rows (a blank url is meaningless) before running. */
function cleanSpec(spec: PrebuildSpec): PrebuildSpec {
  const repos = spec.repos?.filter((repo) => repo.url.trim()) ?? [];
  return { ...spec, repos: repos.length > 0 ? repos : undefined };
}

function PrebuildVisualForm({
  spec,
  onChange,
  onValidityChange,
}: {
  spec: PrebuildSpec;
  onChange: (spec: PrebuildSpec) => void;
  onValidityChange: (valid: boolean) => void;
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

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Dev servers</CardTitle>
          <CardDescription>
            What every sandbox booted from this prebuild runs: its projects' dev
            servers and watchers (several for a monorepo). Applied at boot, so
            changing them never rebuilds.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <RuntimeSurfaceField
            value={{ processes: spec.processes, ports: spec.ports }}
            onChange={({ processes, ports }) => {
              const { processes: _p, ports: _q, ...rest } = spec;
              onChange({
                ...rest,
                ...(processes?.length ? { processes } : {}),
                ...(ports?.length ? { ports } : {}),
              });
            }}
            onValidityChange={onValidityChange}
            defaults={{
              user: "dev",
              lazy: true,
              cwd: cloneCwds(spec.repos)[0],
            }}
            cwdSuggestions={cloneCwds(spec.repos)}
            emptyText="No dev servers: sandboxes boot with just the cloned code."
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
