import type { CatalogEntry } from "@atelier/spec";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { ExternalLink, Loader2, Plus } from "lucide-react";
import { type FormEvent, useState } from "react";
import { catalogListQuery, useAddCatalogEntry } from "@/api/queries/catalog";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { formatRelativeTime } from "@/lib/formatters";

export const Route = createFileRoute("/settings/catalog")({
  component: CatalogPage,
});

function CatalogPage() {
  const {
    data: entries,
    isPending,
    isError,
    error,
  } = useQuery(catalogListQuery());
  const [addOpen, setAddOpen] = useState(false);

  return (
    <div className="space-y-3">
      <div className="flex justify-end">
        <Button size="sm" onClick={() => setAddOpen(true)}>
          <Plus />
          Add artifact
        </Button>
      </div>
      {isPending ? (
        <Skeleton className="h-16 w-full" />
      ) : isError ? (
        <p className="text-sm text-destructive">
          {error instanceof Error ? error.message : "Failed to load"}
        </p>
      ) : entries.length === 0 ? (
        <p className="text-sm text-muted-foreground">Catalog is empty.</p>
      ) : (
        <div className="space-y-2">
          {entries.map((entry) => (
            <CatalogRow key={entry.name} entry={entry} />
          ))}
        </div>
      )}
      <AddArtifactDialog open={addOpen} onOpenChange={setAddOpen} />
    </div>
  );
}

function CatalogRow({ entry }: { entry: CatalogEntry }) {
  return (
    <Card>
      <CardContent className="space-y-1 p-3">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-medium">{entry.name}</span>
          <span className="font-mono text-xs text-muted-foreground">
            {entry.path}
          </span>
          <span className="ml-auto text-xs text-muted-foreground">
            {formatRelativeTime(entry.createdAt)}
          </span>
        </div>
        <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          <span className="truncate font-mono">
            {entry.sha256.slice(0, 16)}…
          </span>
          <a
            href={entry.url}
            target="_blank"
            rel="noreferrer"
            className="flex items-center gap-1 underline"
          >
            source
            <ExternalLink className="size-3" />
          </a>
        </div>
      </CardContent>
    </Card>
  );
}

const SHA256_RE = /^[a-f0-9]{64}$/;
const URL_RE = /^https?:\/\//;

function AddArtifactDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const addEntry = useAddCatalogEntry();
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [sha256, setSha256] = useState("");
  const [path, setPath] = useState("");
  const [executable, setExecutable] = useState(true);

  const urlValid = URL_RE.test(url);
  const shaValid = SHA256_RE.test(sha256);

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (!name || !urlValid || !shaValid) return;
    addEntry.mutate(
      { name, url, sha256, path: path || undefined, executable },
      {
        onSuccess: () => {
          setName("");
          setUrl("");
          setSha256("");
          setPath("");
          setExecutable(true);
          onOpenChange(false);
        },
      },
    );
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <form onSubmit={handleSubmit}>
          <DialogHeader>
            <DialogTitle>Add catalog artifact</DialogTitle>
          </DialogHeader>
          <div className="space-y-3 py-2">
            <div className="space-y-1">
              <Label htmlFor="catalog-name">Name</Label>
              <Input
                id="catalog-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                required
                autoFocus
                placeholder="opencode@1.16.2"
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="catalog-url">URL</Label>
              <Input
                id="catalog-url"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                required
                placeholder="https://…"
              />
              {url && !urlValid ? (
                <p className="text-xs text-destructive">Must be http(s).</p>
              ) : null}
            </div>
            <div className="space-y-1">
              <Label htmlFor="catalog-sha">SHA-256</Label>
              <Input
                id="catalog-sha"
                value={sha256}
                onChange={(e) => setSha256(e.target.value.toLowerCase())}
                required
                className="font-mono"
                placeholder="64 hex chars"
              />
              {sha256 && !shaValid ? (
                <p className="text-xs text-destructive">
                  Must be 64 hexadecimal characters.
                </p>
              ) : null}
            </div>
            <div className="space-y-1">
              <Label htmlFor="catalog-path">Path (optional)</Label>
              <Input
                id="catalog-path"
                value={path}
                onChange={(e) => setPath(e.target.value)}
                placeholder="bin/opencode"
              />
            </div>
            <label
              htmlFor="catalog-executable"
              className="flex items-center gap-2 text-sm"
            >
              <Checkbox
                id="catalog-executable"
                checked={executable}
                onChange={(e) => setExecutable(e.target.checked)}
              />
              Executable
            </label>
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={
                addEntry.isPending ||
                (url.length > 0 && !urlValid) ||
                (sha256.length > 0 && !shaValid)
              }
            >
              {addEntry.isPending ? <Loader2 className="animate-spin" /> : null}
              Add
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
