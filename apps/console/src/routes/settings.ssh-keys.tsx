import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { Loader2, Plus, Trash2 } from "lucide-react";
import { type FormEvent, useState } from "react";
import {
  sshKeysListQuery,
  useCreateSshKey,
  useDeleteSshKey,
} from "@/api/queries/ssh-keys";
import { ConfirmDialog } from "@/components/confirm-dialog";
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
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { formatRelativeTime } from "@/lib/formatters";

export const Route = createFileRoute("/settings/ssh-keys")({
  component: SshKeysPage,
});

function SshKeysPage() {
  const {
    data: keys,
    isPending,
    isError,
    error,
  } = useQuery(sshKeysListQuery());
  const [createOpen, setCreateOpen] = useState(false);

  return (
    <div className="space-y-3">
      <div className="flex justify-end">
        <Button size="sm" onClick={() => setCreateOpen(true)}>
          <Plus />
          Add SSH key
        </Button>
      </div>
      {isPending ? (
        <Skeleton className="h-16 w-full" />
      ) : isError ? (
        <p className="text-sm text-destructive">
          {error instanceof Error ? error.message : "Failed to load"}
        </p>
      ) : keys.length === 0 ? (
        <p className="text-sm text-muted-foreground">No SSH keys yet.</p>
      ) : (
        <div className="space-y-2">
          {keys.map((key) => (
            <SshKeyRow key={key.id} sshKey={key} />
          ))}
        </div>
      )}
      <AddSshKeyDialog open={createOpen} onOpenChange={setCreateOpen} />
    </div>
  );
}

function SshKeyRow({
  sshKey,
}: {
  sshKey: {
    id: string;
    name: string;
    fingerprint: string;
    type: "generated" | "uploaded";
    createdAt: string;
  };
}) {
  const deleteKey = useDeleteSshKey();
  const [confirmOpen, setConfirmOpen] = useState(false);

  return (
    <Card>
      <CardContent className="flex flex-col gap-2 p-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <span className="truncate font-medium">{sshKey.name}</span>
          <Badge variant="outline">{sshKey.type}</Badge>
          <span className="truncate font-mono text-xs text-muted-foreground">
            {sshKey.fingerprint}
          </span>
          <span className="text-xs text-muted-foreground">
            {formatRelativeTime(sshKey.createdAt)}
          </span>
        </div>
        <Button
          variant="outline"
          size="icon"
          disabled={deleteKey.isPending}
          onClick={() => setConfirmOpen(true)}
          aria-label="Delete SSH key"
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
        title="Delete SSH key?"
        description={
          <>
            <span className="font-mono">{sshKey.name}</span> will no longer
            grant access. This cannot be undone.
          </>
        }
        onConfirm={() => deleteKey.mutate(sshKey.id)}
      />
    </Card>
  );
}

function AddSshKeyDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const createKey = useCreateSshKey();
  const [name, setName] = useState("");
  const [publicKey, setPublicKey] = useState("");

  function reset() {
    setName("");
    setPublicKey("");
  }

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (!name || !publicKey.trim()) return;
    createKey.mutate(
      { name, publicKey: publicKey.trim() },
      {
        onSuccess: () => {
          reset();
          onOpenChange(false);
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
        <form onSubmit={handleSubmit}>
          <DialogHeader>
            <DialogTitle>Add SSH key</DialogTitle>
          </DialogHeader>
          <div className="space-y-3 py-2">
            <div className="space-y-1">
              <Label htmlFor="ssh-name">Name</Label>
              <Input
                id="ssh-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                required
                autoFocus
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="ssh-public-key">Public key</Label>
              <textarea
                id="ssh-public-key"
                value={publicKey}
                onChange={(e) => setPublicKey(e.target.value)}
                spellCheck={false}
                required
                placeholder="ssh-ed25519 AAAA…"
                className="min-h-24 w-full rounded-md border bg-muted/30 p-2 font-mono text-xs"
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
              Add
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
