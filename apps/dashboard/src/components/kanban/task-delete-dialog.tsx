import type { Task } from "@frak-sandbox/manager/types";
import { AlertTriangle, Loader2 } from "lucide-react";
import { useState } from "react";
import { useDeleteTask } from "@/api/queries";
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

type TaskDeleteDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  task: Task | null;
};

export function TaskDeleteDialog({
  open,
  onOpenChange,
  task,
}: TaskDeleteDialogProps) {
  const [keepSandbox, setKeepSandbox] = useState(false);
  const deleteMutation = useDeleteTask();

  const hasSandbox = !!task?.data.sandboxId;

  const handleDelete = async () => {
    if (!task) return;

    await deleteMutation.mutateAsync({
      id: task.id,
      keepSandbox: hasSandbox && keepSandbox,
    });

    onOpenChange(false);
  };

  if (!task) return null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[425px]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <AlertTriangle className="h-5 w-5 text-destructive" />
            Delete Task
          </DialogTitle>
          <DialogDescription>
            Are you sure you want to delete &quot;{task.title}&quot;?
          </DialogDescription>
        </DialogHeader>

        {hasSandbox && (
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
                  checked={keepSandbox}
                  onChange={() => setKeepSandbox(true)}
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
                  checked={!keepSandbox}
                  onChange={() => setKeepSandbox(false)}
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
        )}

        {!hasSandbox && (
          <p className="py-4 text-sm text-muted-foreground">
            This action cannot be undone.
          </p>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            variant="destructive"
            onClick={handleDelete}
            disabled={deleteMutation.isPending}
          >
            {deleteMutation.isPending && (
              <Loader2 className="h-4 w-4 mr-2 animate-spin" />
            )}
            Delete Task
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
