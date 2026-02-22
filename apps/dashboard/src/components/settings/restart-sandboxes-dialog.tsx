import { Loader2, RefreshCw } from "lucide-react";
import type { Sandbox } from "@/api/client";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

export function RestartSandboxesDialog({
  open,
  onOpenChange,
  sandboxes,
  selectedIds,
  onSelectedChange,
  onConfirm,
  isRestarting,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  sandboxes: Sandbox[];
  selectedIds: string[];
  onSelectedChange: (ids: string[]) => void;
  onConfirm: () => void;
  isRestarting: boolean;
}) {
  const toggleSandbox = (id: string) => {
    if (selectedIds.includes(id)) {
      onSelectedChange(selectedIds.filter((s) => s !== id));
    } else {
      onSelectedChange([...selectedIds, id]);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Config Updated - Restart Sandboxes?</DialogTitle>
          <DialogDescription>
            Config files have been synced. Running sandboxes need to be
            restarted to pick up the changes.
          </DialogDescription>
        </DialogHeader>

        {sandboxes.length > 0 && (
          <div className="space-y-2 max-h-48 overflow-auto">
            {sandboxes.map((sandbox) => (
              <div key={sandbox.id} className="flex items-center space-x-2">
                <input
                  type="checkbox"
                  id={sandbox.id}
                  checked={selectedIds.includes(sandbox.id)}
                  onChange={() => toggleSandbox(sandbox.id)}
                  className="h-4 w-4 rounded border-gray-300"
                />
                <label
                  htmlFor={sandbox.id}
                  className="text-sm font-medium leading-none cursor-pointer"
                >
                  {sandbox.id}
                  {sandbox.workspaceId && (
                    <span className="text-muted-foreground ml-2">
                      (workspace)
                    </span>
                  )}
                </label>
              </div>
            ))}
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Skip
          </Button>
          <Button
            onClick={onConfirm}
            disabled={isRestarting || selectedIds.length === 0}
          >
            {isRestarting ? (
              <>
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                Restarting...
              </>
            ) : (
              <>
                <RefreshCw className="h-4 w-4 mr-2" />
                Restart {selectedIds.length} Sandbox
                {selectedIds.length !== 1 ? "es" : ""}
              </>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
