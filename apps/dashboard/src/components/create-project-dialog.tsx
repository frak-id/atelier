import { useSuspenseQuery } from "@tanstack/react-query";
import { useState } from "react";
import { imageListQuery, useCreateProject } from "@/api/queries";
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

interface CreateProjectDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function CreateProjectDialog({
  open,
  onOpenChange,
}: CreateProjectDialogProps) {
  const { data: images } = useSuspenseQuery(imageListQuery());
  const createMutation = useCreateProject();

  const [formData, setFormData] = useState({
    name: "",
    gitUrl: "",
    defaultBranch: "main",
    baseImage: "dev-base",
    vcpus: 2,
    memoryMb: 2048,
    initCommands: "",
    startCommands: "",
  });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    createMutation.mutate(
      {
        name: formData.name,
        gitUrl: formData.gitUrl,
        defaultBranch: formData.defaultBranch,
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
      {
        onSuccess: () => {
          onOpenChange(false);
          setFormData({
            name: "",
            gitUrl: "",
            defaultBranch: "main",
            baseImage: "dev-base",
            vcpus: 2,
            memoryMb: 2048,
            initCommands: "",
            startCommands: "",
          });
        },
      },
    );
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <form onSubmit={handleSubmit}>
          <DialogHeader>
            <DialogTitle>Create Project</DialogTitle>
            <DialogDescription>
              Configure a new project for sandbox development
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-4 max-h-[60vh] overflow-y-auto">
            <div className="space-y-2">
              <Label htmlFor="name">Project Name</Label>
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
              <Label htmlFor="gitUrl">Git Repository URL</Label>
              <Input
                id="gitUrl"
                required
                placeholder="https://github.com/org/repo.git"
                value={formData.gitUrl}
                onChange={(e) =>
                  setFormData({ ...formData, gitUrl: e.target.value })
                }
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="branch">Default Branch</Label>
              <Input
                id="branch"
                value={formData.defaultBranch}
                onChange={(e) =>
                  setFormData({ ...formData, defaultBranch: e.target.value })
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
                  {images.map((image) => (
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
                placeholder="bun install&#10;bun run build"
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
                placeholder="bun run dev &"
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
            <Button type="submit" disabled={createMutation.isPending}>
              {createMutation.isPending ? "Creating..." : "Create"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
