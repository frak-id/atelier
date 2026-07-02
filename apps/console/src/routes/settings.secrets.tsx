import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { KeyRound, Loader2, Plus, Trash2 } from "lucide-react";
import { type FormEvent, useState } from "react";
import {
  secretsListQuery,
  useCreateSecret,
  useDeleteSecret,
} from "@/api/queries/secrets";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { OrgSelect } from "@/components/org-select";
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

export const Route = createFileRoute("/settings/secrets")({
  component: SecretsPage,
});

function SecretsPage() {
  const [orgId, setOrgId] = useState("");
  const [createOpen, setCreateOpen] = useState(false);
  const scope = orgId || undefined;
  const {
    data: secrets,
    isPending,
    isError,
    error,
  } = useQuery(secretsListQuery(scope));

  return (
    <div className="space-y-3">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div className="w-full sm:max-w-xs">
          <OrgSelect
            id="secret-org"
            value={orgId}
            onChange={setOrgId}
            noneLabel="Personal (no org)"
          />
        </div>
        <Button size="sm" onClick={() => setCreateOpen(true)}>
          <Plus />
          Add secret
        </Button>
      </div>
      {isPending ? (
        <Skeleton className="h-16 w-full" />
      ) : isError ? (
        <p className="text-sm text-destructive">
          {error instanceof Error ? error.message : "Failed to load"}
        </p>
      ) : secrets.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No secrets in this scope.
        </p>
      ) : (
        <div className="space-y-2">
          {secrets.map((secret) => (
            <SecretRow key={secret.id} secret={secret} />
          ))}
        </div>
      )}
      <AddSecretDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        orgId={scope}
      />
    </div>
  );
}

function SecretRow({
  secret,
}: {
  secret: { id: string; name: string; updatedAt: string };
}) {
  const deleteSecret = useDeleteSecret();
  const [confirmOpen, setConfirmOpen] = useState(false);

  return (
    <Card>
      <CardContent className="flex items-center justify-between p-3">
        <div className="flex min-w-0 items-center gap-2">
          <KeyRound className="size-4 shrink-0 text-muted-foreground" />
          <span className="truncate font-mono text-sm">{secret.name}</span>
          <span className="text-xs text-muted-foreground">
            {formatRelativeTime(secret.updatedAt)}
          </span>
        </div>
        <Button
          variant="outline"
          size="icon"
          disabled={deleteSecret.isPending}
          onClick={() => setConfirmOpen(true)}
          aria-label="Delete secret"
        >
          {deleteSecret.isPending ? (
            <Loader2 className="animate-spin" />
          ) : (
            <Trash2 />
          )}
        </Button>
      </CardContent>
      <ConfirmDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        title="Delete secret?"
        description={
          <>
            Sandboxes referencing{" "}
            <span className="font-mono">{secret.name}</span> will fail to
            resolve it. This cannot be undone.
          </>
        }
        onConfirm={() => deleteSecret.mutate(secret.id)}
      />
    </Card>
  );
}

function AddSecretDialog({
  open,
  onOpenChange,
  orgId,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  orgId?: string;
}) {
  const createSecret = useCreateSecret();
  const [name, setName] = useState("");
  const [value, setValue] = useState("");

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (!name || !value) return;
    createSecret.mutate(
      { orgId, name, value },
      {
        onSuccess: () => {
          setName("");
          setValue("");
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
            <DialogTitle>Add secret</DialogTitle>
          </DialogHeader>
          <div className="space-y-3 py-2">
            <div className="space-y-1">
              <Label htmlFor="secret-name">Name</Label>
              <Input
                id="secret-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                required
                autoFocus
                placeholder="OPENAI_API_KEY"
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="secret-value">Value</Label>
              <textarea
                id="secret-value"
                value={value}
                onChange={(e) => setValue(e.target.value)}
                spellCheck={false}
                required
                className="min-h-20 w-full rounded-md border bg-muted/30 p-2 font-mono text-xs"
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
            <Button type="submit" disabled={createSecret.isPending}>
              {createSecret.isPending ? (
                <Loader2 className="animate-spin" />
              ) : null}
              Save
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
