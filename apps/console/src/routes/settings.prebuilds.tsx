import type { PrebuildSpec } from "@atelier/spec";
import { createFileRoute } from "@tanstack/react-router";
import { type ParseError, parse as parseJsonc } from "jsonc-parser";
import { Hammer, Loader2 } from "lucide-react";
import { useState } from "react";
import { useRunPrebuild } from "@/api/queries/prebuilds";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

export const Route = createFileRoute("/settings/prebuilds")({
  component: PrebuildsPage,
});

const PLACEHOLDER = `{
  "source": { "image": "dev-base-v2" },
  "repos": [{ "url": "https://github.com/org/repo", "branch": "main", "clonePath": "workspace/repo" }],
  "build": ["cd workspace/repo && bun install"]
}`;

/**
 * The repo tier beside the toolset tier (composed-prebuild-volumes.md):
 * content-addressed VolumeSnapshots, chained, node-local. No list endpoint
 * exists server-side (snapshots are an internal runtime concern; only build
 * is exposed) — this mirrors the CLI's `atelier prebuild <file>` exactly.
 */
function PrebuildsPage() {
  const runPrebuild = useRunPrebuild();
  const [text, setText] = useState("");
  const [parseError, setParseError] = useState<string | undefined>();
  const [result, setResult] = useState<{ ref: string; hash: string } | null>(
    null,
  );

  function handleRun() {
    const errors: ParseError[] = [];
    const value = parseJsonc(text, errors, { allowTrailingComma: true }) as
      | PrebuildSpec
      | undefined;
    if (errors.length > 0 || !value) {
      setParseError("Invalid JSON — check syntax");
      return;
    }
    setParseError(undefined);
    runPrebuild.mutate(value, {
      onSuccess: (data) => setResult(data ?? null),
    });
  }

  return (
    <div className="space-y-3">
      <Card>
        <CardHeader>
          <CardTitle>Run a prebuild</CardTitle>
          <CardDescription>
            Chained, content-addressed repo snapshot — clone +{" "}
            <code>build[]</code> baked into a VolumeSnapshot, reusable as a
            sandbox <code>source.snapshot</code>. Idempotent: identical content
            hashes return instantly.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-2">
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            spellCheck={false}
            placeholder={PLACEHOLDER}
            className="min-h-56 w-full rounded-md border bg-muted/30 p-2 font-mono text-xs"
          />
          {parseError ? (
            <p className="text-sm text-destructive">{parseError}</p>
          ) : null}
          <Button disabled={runPrebuild.isPending} onClick={handleRun}>
            {runPrebuild.isPending ? (
              <Loader2 className="animate-spin" />
            ) : (
              <Hammer />
            )}
            Run prebuild
          </Button>
          {result ? (
            <p className="font-mono text-xs text-muted-foreground">
              {result.ref} ({result.hash})
            </p>
          ) : null}
        </CardContent>
      </Card>
    </div>
  );
}
