import { useSuspenseQuery } from "@tanstack/react-query";
import { useState } from "react";
import type { Workspace } from "@/api/client";
import { imageListQuery, useUpdateWorkspace } from "@/api/queries";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";

interface EditWorkspaceDialogProps {
  workspace: Workspace;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function EditWorkspaceDialog({
  workspace,
  open,
  onOpenChange,
}: EditWorkspaceDialogProps) {
  const { data: images } = useSuspenseQuery(imageListQuery());
  const updateMutation = useUpdateWorkspace();

  const [formData, setFormData] = useState({
    name: workspace.name,
    baseImage: workspace.config.baseImage,
    vcpus: workspace.config.vcpus,
    memoryMb: workspace.config.memoryMb,
    initCommands: workspace.config.initCommands.join("\n"),
    startCommands: workspace.config.startCommands.join("\n"),
  });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    updateMutation.mutate(
      {
        id: workspace.id,
        data: {
          name: formData.name,
          config: {
            ...workspace.config,
            baseImage: formData.baseImage,
            vcpus: formData.vcpus,
            memoryMb: formData.memoryMb,
            initCommands: formData.initCommands
              .split("\n")
              .filter((cmd) => cmd.trim()),
            startCommands: formData.startCommands
              .split("\n")
              .filter((cmd) => cmd.trim()),
          },
        },
      },
      {
        onSuccess: () => onOpenChange(false),
      },
    );
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg max-h-[90vh] overflow-y-auto">
        <form onSubmit={handleSubmit}>
          <DialogHeader>
            <DialogTitle>Edit Workspace</DialogTitle>
            <DialogDescription>
              Update workspace configuration
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label htmlFor="name">Workspace Name</Label>
              <Input
                id="name"
                required
                value={formData.name}
                onChange={(e) =>
                  setFormData({ ...formData, name: e.target.value })
                }
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="image">Base Image</Label>
              <Select
                value={formData.baseImage}
                onValueChange={(value) =>
                  setFormData({ ...formData, baseImage: value })
                }
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {images?.map((image) => (
                    <SelectItem key={image.id} value={image.id}>
                      {image.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="vcpus">vCPUs</Label>
                <Select
                  value={String(formData.vcpus)}
                  onValueChange={(value) =>
                    setFormData({ ...formData, vcpus: parseInt(value, 10) })
                  }
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="1">1 vCPU</SelectItem>
                    <SelectItem value="2">2 vCPUs</SelectItem>
                    <SelectItem value="4">4 vCPUs</SelectItem>
                    <SelectItem value="8">8 vCPUs</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-2">
                <Label htmlFor="memory">Memory</Label>
                <Select
                  value={String(formData.memoryMb)}
                  onValueChange={(value) =>
                    setFormData({ ...formData, memoryMb: parseInt(value, 10) })
                  }
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="1024">1 GB</SelectItem>
                    <SelectItem value="2048">2 GB</SelectItem>
                    <SelectItem value="4096">4 GB</SelectItem>
                    <SelectItem value="8192">8 GB</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>

            <div className="space-y-2">
              <Label htmlFor="initCommands">Init Commands (one per line)</Label>
              <Textarea
                id="initCommands"
                rows={3}
                value={formData.initCommands}
                onChange={(e) =>
                  setFormData({ ...formData, initCommands: e.target.value })
                }
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="startCommands">
                Start Commands (one per line)
              </Label>
              <Textarea
                id="startCommands"
                rows={2}
                value={formData.startCommands}
                onChange={(e) =>
                  setFormData({ ...formData, startCommands: e.target.value })
                }
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
            <Button type="submit" disabled={updateMutation.isPending}>
              {updateMutation.isPending ? "Saving..." : "Save"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
