import { useQuery, useSuspenseQuery } from "@tanstack/react-query";
import { useState } from "react";
import { api } from "@/api/client";
import {
  githubStatusQuery,
  imageListQuery,
  useCreateWorkspace,
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
import { Label } from "@/components/ui/label";
import {
  CommandsForm,
  GeneralForm,
  type GitSourceInfo,
  RepoAddForm,
  type RepoEntry,
  RepoItem,
  serializeRepos,
} from "@/components/workspace-form";

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
  const { data: gitSources } = useQuery({
    queryKey: ["git-sources"],
    queryFn: async () => {
      const result = await api.api.sources.get();
      if (result.error) throw result.error;
      return result.data as GitSourceInfo[];
    },
  });
  const createMutation = useCreateWorkspace();

  const [formData, setFormData] = useState({
    name: "",
    baseImage: "dev-base",
    vcpus: 2,
    memoryMb: 2048,
    initCommands: "",
  });
  const [repos, setRepos] = useState<RepoEntry[]>([]);

  const isGitHubConnected = githubStatus?.connected === true;

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
            .filter((cmd: string) => cmd.trim()),
          repos: serializeRepos(repos),
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
            <GeneralForm
              name={formData.name}
              baseImage={formData.baseImage}
              vcpus={formData.vcpus}
              memoryMb={formData.memoryMb}
              images={images ?? []}
              onNameChange={(name) => setFormData({ ...formData, name })}
              onBaseImageChange={(baseImage) =>
                setFormData({ ...formData, baseImage })
              }
              onVcpusChange={(vcpus) => setFormData({ ...formData, vcpus })}
              onMemoryMbChange={(memoryMb) =>
                setFormData({ ...formData, memoryMb })
              }
            />

            <div className="space-y-2">
              <Label>Repositories</Label>
              {repos.length > 0 && (
                <div className="space-y-3 mb-2">
                  {repos.map((repo, idx) => (
                    <RepoItem
                      key={
                        repo.url ||
                        (repo.sourceId && repo.repo
                          ? `${repo.sourceId}:${repo.repo}`
                          : `new-${idx}`)
                      }
                      repo={repo}
                      variant="muted"
                      onUpdate={(updates) =>
                        setRepos((prev) =>
                          prev.map((r, i) =>
                            i === idx ? { ...r, ...updates } : r,
                          ),
                        )
                      }
                      onRemove={() =>
                        setRepos((prev) => prev.filter((_, i) => i !== idx))
                      }
                    />
                  ))}
                </div>
              )}
              <RepoAddForm
                isGitHubConnected={isGitHubConnected}
                gitSources={gitSources}
                onAdd={(repo) => setRepos([...repos, repo])}
                onRepoSelected={(repoName) => {
                  if (!formData.name) {
                    setFormData({ ...formData, name: repoName });
                  }
                }}
              />
            </div>

            <CommandsForm
              initCommands={formData.initCommands}
              onInitCommandsChange={(initCommands) =>
                setFormData({ ...formData, initCommands })
              }
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
            <Button type="submit" disabled={createMutation.isPending}>
              {createMutation.isPending ? "Creating..." : "Create"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
