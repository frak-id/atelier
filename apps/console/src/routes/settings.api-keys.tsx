import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { Copy, Loader2, Plus, Trash2 } from "lucide-react";
import { type FormEvent, useState } from "react";
import { toast } from "sonner";
import {
  apiKeysListQuery,
  useCreateApiKey,
  useDeleteApiKey,
} from "@/api/queries/api-keys";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
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

export const Route = createFileRoute("/settings/api-keys")({
  component: ApiKeysPage,
});

function ApiKeysPage() {
  const {
    data: keys,
    isPending,
    isError,
    error,
  } = useQuery(apiKeysListQuery());
  const [createOpen, setCreateOpen] = useState(false);

  return (
    <div className="space-y-3">
      <div className="flex justify-end">
        <Button size="sm" onClick={() => setCreateOpen(true)}>
          <Plus />
          Create API key
        </Button>
      </div>
      {isPending ? (
        <Skeleton className="h-16 w-full" />
      ) : isError ? (
        <p className="text-sm text-destructive">
          {error instanceof Error ? error.message : "Failed to load"}
        </p>
      ) : keys.length === 0 ? (
        <p className="text-sm text-muted-foreground">No API keys yet.</p>
      ) : (
        <div className="space-y-2">
          {keys.map((key) => (
            <ApiKeyRow key={key.id} apiKey={key} />
          ))}
        </div>
      )}
      <CreateApiKeyDialog open={createOpen} onOpenChange={setCreateOpen} />
    </div>
  );
}

function ApiKeyRow({
  apiKey,
}: {
  apiKey: {
    id: string;
    name: string;
    keyPrefix: string;
    createdAt: string;
    lastUsedAt: string | null;
    expiresAt: string | null;
  };
}) {
  const deleteKey = useDeleteApiKey();
  const [confirmOpen, setConfirmOpen] = useState(false);

  return (
    <Card>
      <CardContent className="flex flex-col gap-2 p-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <span className="truncate font-medium">{apiKey.name}</span>
          <Badge variant="outline" className="font-mono">
            {apiKey.keyPrefix}…
          </Badge>
          <span className="text-xs text-muted-foreground">
            created {formatRelativeTime(apiKey.createdAt)}
          </span>
          {apiKey.lastUsedAt ? (
            <span className="text-xs text-muted-foreground">
              · used {formatRelativeTime(apiKey.lastUsedAt)}
            </span>
          ) : null}
          {apiKey.expiresAt ? (
            <span className="text-xs text-muted-foreground">
              · expires {formatRelativeTime(apiKey.expiresAt)}
            </span>
          ) : null}
        </div>
        <Button
          variant="outline"
          size="icon"
          disabled={deleteKey.isPending}
          onClick={() => setConfirmOpen(true)}
          aria-label="Delete API key"
        >
          {deleteKey.isPending ? (
            <Loader2 className="animate-spin" />
          ) : (
            <Trash2 />
          )}
        </Button>
      </CardContent>
      <ConfirmDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        title="Delete API key?"
        description={
          <>
            Applications using <span className="font-mono">{apiKey.name}</span>{" "}
            will stop working. This cannot be undone.
          </>
        }
        onConfirm={() => deleteKey.mutate(apiKey.id)}
      />
    </Card>
  );
}

function CreateApiKeyDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const createKey = useCreateApiKey();
  const [name, setName] = useState("");
  const [expiresAt, setExpiresAt] = useState("");
  const [rawKey, setRawKey] = useState<string | null>(null);

  function reset() {
    setName("");
    setExpiresAt("");
    setRawKey(null);
  }

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (!name) return;
    createKey.mutate(
      { name, expiresAt: expiresAt || undefined },
      {
        onSuccess: (data) => {
          if (data) setRawKey(data.rawKey);
        },
      },
    );
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) reset();
        onOpenChange(next);
      }}
    >
      <DialogContent>
        {rawKey ? (
          <>
            <DialogHeader>
              <DialogTitle>API key created</DialogTitle>
              <DialogDescription>
                Copy it now — it will not be shown again.
              </DialogDescription>
            </DialogHeader>
            <div className="flex items-center gap-2">
              <code className="min-w-0 flex-1 truncate rounded-md bg-muted p-2 font-mono text-xs">
                {rawKey}
              </code>
              <Button
                size="icon"
                variant="outline"
                onClick={() => {
                  navigator.clipboard.writeText(rawKey);
                  toast.success("Copied to clipboard");
                }}
                aria-label="Copy API key"
              >
                <Copy />
              </Button>
            </div>
            <DialogFooter>
              <Button
                onClick={() => {
                  reset();
                  onOpenChange(false);
                }}
              >
                Done
              </Button>
            </DialogFooter>
          </>
        ) : (
          <form onSubmit={handleSubmit}>
            <DialogHeader>
              <DialogTitle>Create API key</DialogTitle>
            </DialogHeader>
            <div className="space-y-3 py-2">
              <div className="space-y-1">
                <Label htmlFor="key-name">Name</Label>
                <Input
                  id="key-name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  required
                  autoFocus
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="key-expires">Expires (optional)</Label>
                <Input
                  id="key-expires"
                  type="date"
                  value={expiresAt}
                  onChange={(e) => setExpiresAt(e.target.value)}
                />
              </div>
            </div>
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => onOpenChange(false)}
              >
                Cancel
              </Button>
              <Button type="submit" disabled={createKey.isPending}>
                {createKey.isPending ? (
                  <Loader2 className="animate-spin" />
                ) : null}
                Create
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
