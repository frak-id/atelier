import { useQuery, useSuspenseQuery } from "@tanstack/react-query";
import { ChevronDown, ChevronUp, Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import {
  githubStatusQuery,
  imageListQuery,
  useCreateWorkspace,
} from "@/api/queries";
import { RepositoryPicker } from "@/components/repository-picker";
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

interface RepoEntry {
  url: string;
  branch: string;
  clonePath: string;
}

interface CreateWorkspaceDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function CreateWorkspaceDialog({
  open,
  onOpenChange,
}: CreateWorkspaceDialogProps) {
  const { data: images } = useSuspenseQuery(imageListQuery());
  const { data: githubStatus } = useQuery(githubStatusQuery);
  const createMutation = useCreateWorkspace();

  const [showManualUrl, setShowManualUrl] = useState(false);
  const [formData, setFormData] = useState({
    name: "",
    baseImage: "dev-base",
    vcpus: 2,
    memoryMb: 2048,
    initCommands: "",
    startCommands: "",
  });
  const [repos, setRepos] = useState<RepoEntry[]>([]);
  const [newRepo, setNewRepo] = useState<RepoEntry>({
    url: "",
    branch: "main",
    clonePath: "/workspace",
  });

  const isGitHubConnected = githubStatus?.connected === true;

  const addRepo = () => {
    if (newRepo.url) {
      setRepos([...repos, newRepo]);
      setNewRepo({ url: "", branch: "main", clonePath: "/workspace" });
    }
  };

  const removeRepo = (index: number) => {
    setRepos(repos.filter((_, i) => i !== index));
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    createMutation.mutate(
      {
        name: formData.name,
        config: {
          baseImage: formData.baseImage,
          vcpus: formData.vcpus,
          memoryMb: formData.memoryMb,
          initCommands: formData.initCommands
            .split("\n")
            .filter((cmd) => cmd.trim()),
          startCommands: formData.startCommands
            .split("\n")
            .filter((cmd) => cmd.trim()),
          repos: repos.map((r) => ({
            url: r.url,
            branch: r.branch,
            clonePath: r.clonePath,
          })),
          secrets: {},
          exposedPorts: [],
        },
      },
      {
        onSuccess: () => {
          onOpenChange(false);
          setFormData({
            name: "",
            baseImage: "dev-base",
            vcpus: 2,
            memoryMb: 2048,
            initCommands: "",
            startCommands: "",
          });
          setRepos([]);
        },
      },
    );
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg max-h-[90vh] overflow-y-auto">
        <form onSubmit={handleSubmit}>
          <DialogHeader>
            <DialogTitle>Create Workspace</DialogTitle>
            <DialogDescription>
              Configure a new workspace for sandbox development
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
              <Label>Repositories</Label>
              {repos.length > 0 && (
                <div className="space-y-2 mb-2">
                  {repos.map((repo, idx) => (
                    <div
                      key={`repo-${idx}`}
                      className="flex items-center gap-2 p-2 bg-muted rounded text-sm min-w-0"
                    >
                      <span className="flex-1 font-mono truncate min-w-0">
                        {repo.url}
                      </span>
                      <span className="text-muted-foreground truncate shrink-0 max-w-[40%]">
                        → {repo.clonePath}
                      </span>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        className="shrink-0"
                        onClick={() => removeRepo(idx)}
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </div>
                  ))}
                </div>
              )}

              {isGitHubConnected && !showManualUrl ? (
                <div className="space-y-2">
                  <RepositoryPicker
                    value={newRepo.url}
                    onSelect={(repo) => {
                      setNewRepo({
                        url: repo.cloneUrl,
                        branch: repo.defaultBranch,
                        clonePath: `/workspace/${repo.name}`,
                      });
                      if (!formData.name) {
                        setFormData({ ...formData, name: repo.name });
                      }
                    }}
                  />
                  <div className="flex gap-2">
                    <Input
                      placeholder="Clone path"
                      value={newRepo.clonePath}
                      onChange={(e) =>
                        setNewRepo({ ...newRepo, clonePath: e.target.value })
                      }
                    />
                    <Button
                      type="button"
                      onClick={addRepo}
                      disabled={!newRepo.url}
                    >
                      <Plus className="h-4 w-4" />
                    </Button>
                  </div>
                  <button
                    type="button"
                    onClick={() => setShowManualUrl(true)}
                    className="text-xs text-muted-foreground hover:text-foreground flex items-center gap-1"
                  >
                    <ChevronDown className="h-3 w-3" />
                    Or enter URL manually
                  </button>
                </div>
              ) : (
                <div className="space-y-2">
                  <div className="flex gap-2">
                    <Input
                      placeholder="https://github.com/org/repo.git"
                      value={newRepo.url}
                      onChange={(e) =>
                        setNewRepo({ ...newRepo, url: e.target.value })
                      }
                    />
                  </div>
                  <div className="flex gap-2">
                    <Input
                      placeholder="Branch"
                      value={newRepo.branch}
                      onChange={(e) =>
                        setNewRepo({ ...newRepo, branch: e.target.value })
                      }
                    />
                    <Input
                      placeholder="Clone path"
                      value={newRepo.clonePath}
                      onChange={(e) =>
                        setNewRepo({ ...newRepo, clonePath: e.target.value })
                      }
                    />
                    <Button
                      type="button"
                      onClick={addRepo}
                      disabled={!newRepo.url}
                    >
                      <Plus className="h-4 w-4" />
                    </Button>
                  </div>
                  {isGitHubConnected && (
                    <button
                      type="button"
                      onClick={() => setShowManualUrl(false)}
                      className="text-xs text-muted-foreground hover:text-foreground flex items-center gap-1"
                    >
                      <ChevronUp className="h-3 w-3" />
                      Select from GitHub
                    </button>
                  )}
                </div>
              )}
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
