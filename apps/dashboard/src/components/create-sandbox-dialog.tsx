import { useSuspenseQuery } from "@tanstack/react-query";
import { useState } from "react";
import {
  imageListQuery,
  projectListQuery,
  useCreateSandbox,
} from "@/api/queries";
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

interface CreateSandboxDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function CreateSandboxDialog({
  open,
  onOpenChange,
}: CreateSandboxDialogProps) {
  const { data: images } = useSuspenseQuery(imageListQuery());
  const { data: projects } = useSuspenseQuery(projectListQuery());
  const createMutation = useCreateSandbox();

  const [formData, setFormData] = useState({
    id: "",
    projectId: "",
    baseImage: "dev-base",
    vcpus: 2,
    memoryMb: 2048,
  });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    createMutation.mutate(
      {
        id: formData.id || undefined,
        projectId: formData.projectId || undefined,
        baseImage: formData.baseImage,
        vcpus: formData.vcpus,
        memoryMb: formData.memoryMb,
      },
      {
        onSuccess: () => {
          onOpenChange(false);
          setFormData({
            id: "",
            projectId: "",
            baseImage: "dev-base",
            vcpus: 2,
            memoryMb: 2048,
          });
        },
      },
    );
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <form onSubmit={handleSubmit}>
          <DialogHeader>
            <DialogTitle>Create Sandbox</DialogTitle>
            <DialogDescription>
              Spin up a new development environment
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label htmlFor="id">Sandbox ID (optional)</Label>
              <Input
                id="id"
                placeholder="Auto-generated if empty"
                value={formData.id}
                onChange={(e) =>
                  setFormData({ ...formData, id: e.target.value })
                }
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="project">Project (optional)</Label>
              <Select
                value={formData.projectId}
                onValueChange={(value) =>
                  setFormData({ ...formData, projectId: value })
                }
              >
                <SelectTrigger>
                  <SelectValue placeholder="No project" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="">No project</SelectItem>
                  {projects.map((project) => (
                    <SelectItem key={project.id} value={project.id}>
                      {project.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
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
                    <SelectItem
                      key={image.id}
                      value={image.id}
                      disabled={!image.available}
                    >
                      {image.name} {!image.available && "(not built)"}
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
