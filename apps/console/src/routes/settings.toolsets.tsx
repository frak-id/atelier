import type { ToolsetBuildRequest, ToolsetEntry } from "@atelier/spec";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { type ParseError, parse as parseJsonc } from "jsonc-parser";
import { Loader2, Plus } from "lucide-react";
import { type FormEvent, useState } from "react";
import {
  toolsetsListQuery,
  useBuildToolset,
  usePublishToolset,
  useRemoveToolset,
} from "@/api/queries/toolsets";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { formatRelativeTime } from "@/lib/formatters";

export const Route = createFileRoute("/settings/toolsets")({
  component: ToolsetsPage,
});

const BUILD_PLACEHOLDER = `{
  "name": "my-toolset",
  "build": ["curl -fsSL https://example.com/tool -o ~/.local/bin/tool", "chmod +x ~/.local/bin/tool"],
  "paths": ["~/.local/bin/tool"]
}`;

function ToolsetsPage() {
  const {
    data: toolsets,
    isPending,
    isError,
    error,
  } = useQuery(toolsetsListQuery());
  const [buildOpen, setBuildOpen] = useState(false);

  return (
    <div className="space-y-3">
      <div className="flex items-start justify-between gap-2">
        <p className="text-sm text-muted-foreground">
          Toolset artifacts — harness/tool bundles materialized into every
          sandbox's home at boot. Built toolsets are reproducible (rebuilt from{" "}
          <code>build[]</code>); captured toolsets are private snapshots of a
          live sandbox.
        </p>
        <Button size="sm" onClick={() => setBuildOpen(true)}>
          <Plus />
          Build
        </Button>
      </div>
      {isPending ? (
        <Skeleton className="h-16 w-full" />
      ) : isError ? (
        <p className="text-sm text-destructive">
          {error instanceof Error ? error.message : "Failed to load"}
        </p>
      ) : !toolsets || toolsets.length === 0 ? (
        <p className="text-sm text-muted-foreground">No toolsets yet.</p>
      ) : (
        <div className="space-y-2">
          {toolsets.map((toolset) => (
            <ToolsetRow key={toolset.ref} toolset={toolset} />
          ))}
        </div>
      )}
      <BuildToolsetDialog open={buildOpen} onOpenChange={setBuildOpen} />
    </div>
  );
}

function ToolsetRow({ toolset }: { toolset: ToolsetEntry }) {
  const publish = usePublishToolset();
  const remove = useRemoveToolset();
  return (
    <Card>
      <CardContent className="flex flex-col gap-2 p-3">
        <div className="flex flex-wrap items-center gap-2">
          <span className="truncate font-medium">{toolset.name}</span>
          <Badge
            variant={
              toolset.provenance.kind === "built" ? "outline" : "secondary"
            }
          >
            {toolset.provenance.kind}
          </Badge>
          {toolset.private ? <Badge variant="outline">private</Badge> : null}
          <span className="text-xs text-muted-foreground">
            {formatRelativeTime(toolset.createdAt)}
          </span>
          <div className="ml-auto flex gap-1">
            {toolset.private ? (
              <Button
                size="sm"
                variant="outline"
                disabled={publish.isPending}
                onClick={() => publish.mutate(toolset.ref)}
              >
                Publish
              </Button>
            ) : null}
            <Button
              size="sm"
              variant="ghost"
              disabled={remove.isPending}
              onClick={() => remove.mutate(toolset.ref)}
            >
              Remove
            </Button>
          </div>
        </div>
        <span className="truncate font-mono text-xs text-muted-foreground">
          {toolset.ref}
        </span>
        <div className="flex flex-wrap gap-1">
          {toolset.paths.map((path) => (
            <Badge key={path} variant="outline" className="font-mono text-xs">
              {path}
            </Badge>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

function BuildToolsetDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const buildToolset = useBuildToolset();
  const [text, setText] = useState("");
  const [parseError, setParseError] = useState<string | undefined>();

  function reset() {
    setText("");
    setParseError(undefined);
  }

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    const errors: ParseError[] = [];
    const value = parseJsonc(text, errors, { allowTrailingComma: true }) as
      | ToolsetBuildRequest
      | undefined;
    if (errors.length > 0 || !value) {
      setParseError("Invalid JSON — check syntax");
      return;
    }
    setParseError(undefined);
    buildToolset.mutate(value, {
      onSuccess: () => {
        reset();
        onOpenChange(false);
      },
    });
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) reset();
        onOpenChange(next);
      }}
    >
      <DialogContent className="max-w-xl">
        <form onSubmit={handleSubmit}>
          <DialogHeader>
            <DialogTitle>Build a toolset</DialogTitle>
          </DialogHeader>
          <div className="space-y-2 py-2">
            <textarea
              value={text}
              onChange={(e) => setText(e.target.value)}
              spellCheck={false}
              required
              placeholder={BUILD_PLACEHOLDER}
              className="min-h-56 w-full rounded-md border bg-muted/30 p-2 font-mono text-xs"
            />
            {parseError ? (
              <p className="text-sm text-destructive">{parseError}</p>
            ) : null}
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={buildToolset.isPending}>
              {buildToolset.isPending ? (
                <Loader2 className="animate-spin" />
              ) : null}
              Build
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
