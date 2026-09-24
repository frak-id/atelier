import type { PrebuildSpec, Source } from "@atelier/spec";
import { useNavigate } from "@tanstack/react-router";
import { Hammer, Loader2 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { useRunPrebuild } from "@/api/queries/prebuilds";
import { ImageSourcePicker } from "@/components/image-source-picker";
import { ReposField } from "@/components/repos-field";
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
