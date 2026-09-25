import { SANDBOX_NAME_MAX_LENGTH } from "@atelier/spec";
import { Loader2 } from "lucide-react";
import { type FormEvent, useEffect, useState } from "react";
import { useRenameSandbox } from "@/api/queries/sandboxes";
import { Button } from "@/components/ui/button";
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

/**
 * Give a sandbox a display name (shown instead of its id across the
 * console). Controlled via `open`; closes itself once the rename lands.
 * Saving an empty name clears it, falling back to the id.
 */
export function RenameSandboxDialog({
  sandboxId,
  currentName,
  open,
  onOpenChange,
}: {
  sandboxId: string;
  currentName: string | undefined;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const rename = useRenameSandbox();
  const [name, setName] = useState(currentName ?? "");

  // Re-seed on every open: the name may have changed since the last one.
  useEffect(() => {
    if (open) setName(currentName ?? "");
  }, [open, currentName]);

  const unchanged = name.trim() === (currentName ?? "");

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (unchanged) {
      onOpenChange(false);
      return;
    }
    rename.mutate(
      { id: sandboxId, name },
      { onSuccess: () => onOpenChange(false) },
    );
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <form onSubmit={handleSubmit} className="space-y-4">
          <DialogHeader>
            <DialogTitle>Rename sandbox</DialogTitle>
            <DialogDescription>
              Shown instead of <span className="font-mono">{sandboxId}</span>.
              Leave empty to show the id again.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-1">
            <Label htmlFor={`sandbox-name-${sandboxId}`}>Name</Label>
            <Input
              id={`sandbox-name-${sandboxId}`}
              value={name}
              maxLength={SANDBOX_NAME_MAX_LENGTH}
              placeholder={sandboxId}
              autoFocus
              autoComplete="off"
              onChange={(e) => setName(e.target.value)}
            />
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={rename.isPending || unchanged}>
              {rename.isPending ? <Loader2 className="animate-spin" /> : null}
              Save
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
