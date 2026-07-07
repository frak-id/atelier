import type { PrebuildRecord, PrebuildSpec } from "@atelier/spec";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { type ParseError, parse as parseJsonc } from "jsonc-parser";
import { Hammer, Layers, Loader2, RefreshCw, Trash2 } from "lucide-react";
import { useState } from "react";
import {
  prebuildsListQuery,
  useDeletePrebuild,
  useRunPrebuild,
} from "@/api/queries/prebuilds";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { formatRelativeTime } from "@/lib/formatters";

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
    runPrebuild.mutate(
      { spec: value },
      { onSuccess: (data) => setResult(data ?? null) },
    );
  }

  return (
    <div className="space-y-3">
      <PrebuildsList />
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

/** Short, human summary of a prebuild's opaque metadata (workspace/repo…). */
function metadataSummary(metadata?: Record<string, string>): string | null {
  if (!metadata) return null;
  const entries = Object.entries(metadata);
  if (entries.length === 0) return null;
  return entries.map(([k, v]) => `${k}: ${v}`).join(" · ");
}

function PrebuildsList() {
  const {
    data: prebuilds,
    isPending,
    isError,
    error,
  } = useQuery(prebuildsListQuery());
  const runPrebuild = useRunPrebuild();
  const deletePrebuild = useDeletePrebuild();

  return (
    <Card>
      <CardHeader>
        <CardTitle>Prebuilds</CardTitle>
        <CardDescription>
          Stored workspace snapshots, reusable as a boot{" "}
          <code>source.snapshot</code>. One-tap spawn from the{" "}
          <a href="/spawn" className="underline">
            Spawn
          </a>{" "}
          page.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-2">
        {isPending ? (
          <Skeleton className="h-12 w-full" />
        ) : isError ? (
          <p className="text-sm text-destructive">
            {error instanceof Error ? error.message : "Failed to load"}
          </p>
        ) : !prebuilds || prebuilds.length === 0 ? (
          <p className="text-sm text-muted-foreground">No prebuilds yet.</p>
        ) : (
          prebuilds.map((prebuild: PrebuildRecord) => {
            const summary = metadataSummary(prebuild.metadata);
            const spec = prebuild.spec;
            return (
              <div
                key={prebuild.ref}
                className="flex flex-col gap-1 rounded-md border p-3"
              >
                <div className="flex flex-wrap items-center gap-2">
                  <Layers className="size-4 shrink-0 text-muted-foreground" />
                  <span className="truncate font-mono text-sm">
                    {prebuild.ref}
                  </span>
                  {prebuild.parent ? (
                    <Badge variant="outline">chained</Badge>
                  ) : null}
                  {prebuild.inUse ? (
                    <Badge variant="secondary">in use</Badge>
                  ) : null}
                  <span className="text-xs text-muted-foreground">
                    {formatRelativeTime(prebuild.createdAt)}
                  </span>
                  <div className="ml-auto flex items-center gap-2">
                    {spec ? (
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={runPrebuild.isPending}
                        onClick={() =>
                          runPrebuild.mutate({ spec, force: true })
                        }
                      >
                        {runPrebuild.isPending ? (
                          <Loader2 className="animate-spin" />
                        ) : (
                          <RefreshCw />
                        )}
                        Rebuild
                      </Button>
                    ) : null}
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={prebuild.inUse || deletePrebuild.isPending}
                      title={
                        prebuild.inUse
                          ? "In use by a sandbox or a chained prebuild"
                          : "Delete this snapshot"
                      }
                      onClick={() => deletePrebuild.mutate(prebuild.ref)}
                    >
                      {deletePrebuild.isPending ? (
                        <Loader2 className="animate-spin" />
                      ) : (
                        <Trash2 />
                      )}
                      Delete
                    </Button>
                  </div>
                </div>
                {summary ? (
                  <span className="text-sm text-muted-foreground">
                    {summary}
                  </span>
                ) : null}
                <span className="truncate font-mono text-xs text-muted-foreground">
                  {prebuild.image}
                </span>
              </div>
            );
          })
        )}
      </CardContent>
    </Card>
  );
}
