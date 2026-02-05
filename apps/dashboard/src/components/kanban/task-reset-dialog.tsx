import type { Task } from "@frak/atelier-manager/types";
import { Loader2, RotateCcw } from "lucide-react";
import { useState } from "react";
import { useResetTask } from "@/api/queries";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";

type SandboxAction = "detach" | "stop" | "destroy";

type TaskResetDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  task: Task | null;
};

export function TaskResetDialog({
  open,
  onOpenChange,
  task,
}: TaskResetDialogProps) {
  const [sandboxAction, setSandboxAction] = useState<SandboxAction>("detach");
  const resetMutation = useResetTask();

  const hasSandbox = !!task?.data.sandboxId;

  const handleReset = async () => {
    if (!task) return;

    await resetMutation.mutateAsync({
      id: task.id,
      sandboxAction: hasSandbox ? sandboxAction : undefined,
    });

    onOpenChange(false);
  };

  if (!task) return null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[425px]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <RotateCcw className="h-5 w-5" />
            Reset to Draft
          </DialogTitle>
          <DialogDescription>
            Reset &quot;{task.title}&quot; back to draft status?
          </DialogDescription>
        </DialogHeader>

        {hasSandbox ? (
          <div className="py-4">
            <p className="text-sm text-muted-foreground mb-3">
              This task has an associated sandbox. What would you like to do
              with it?
            </p>
            <div className="space-y-2">
              <label className="flex items-center gap-2 p-3 border rounded-lg cursor-pointer hover:bg-accent/50 transition-colors">
                <input
                  type="radio"
                  name="sandboxAction"
                  checked={sandboxAction === "detach"}
                  onChange={() => setSandboxAction("detach")}
                  className="h-4 w-4"
                />
                <div>
                  <Label className="cursor-pointer">
                    Leave sandbox running
                  </Label>
                  <p className="text-xs text-muted-foreground">
                    The sandbox will keep running independently
                  </p>
                </div>
              </label>
              <label className="flex items-center gap-2 p-3 border rounded-lg cursor-pointer hover:bg-accent/50 transition-colors">
                <input
                  type="radio"
                  name="sandboxAction"
                  checked={sandboxAction === "stop"}
                  onChange={() => setSandboxAction("stop")}
                  className="h-4 w-4"
                />
                <div>
                  <Label className="cursor-pointer">
                    Stop sandbox (keep data)
                  </Label>
                  <p className="text-xs text-muted-foreground">
                    The sandbox will be stopped but data will be preserved
                  </p>
                </div>
              </label>
              <label className="flex items-center gap-2 p-3 border rounded-lg cursor-pointer hover:bg-accent/50 transition-colors">
                <input
                  type="radio"
                  name="sandboxAction"
                  checked={sandboxAction === "destroy"}
                  onChange={() => setSandboxAction("destroy")}
                  className="h-4 w-4"
                />
                <div>
                  <Label className="cursor-pointer text-destructive">
                    Delete sandbox (remove all data)
                  </Label>
                  <p className="text-xs text-muted-foreground">
                    The sandbox and all its data will be permanently deleted
                  </p>
                </div>
              </label>
            </div>
          </div>
        ) : (
          <p className="py-4 text-sm text-muted-foreground">
            The task will be moved back to draft. Sessions and branch data will
            be cleared.
          </p>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={handleReset} disabled={resetMutation.isPending}>
            {resetMutation.isPending && (
              <Loader2 className="h-4 w-4 mr-2 animate-spin" />
            )}
            Reset to Draft
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
