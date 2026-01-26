import { useQuery, useSuspenseQuery } from "@tanstack/react-query";
import { Plus } from "lucide-react";
import { useState } from "react";
import type { Workspace } from "@/api/client";
import { api } from "@/api/client";
import {
  githubStatusQuery,
  imageListQuery,
  useUpdateWorkspace,
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
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  CommandsForm,
  type EnvSecret,
  type FileSecretInput,
  GeneralForm,
  type GitSourceInfo,
  parseEnvSecrets,
  parseFileSecrets,
  RepoAddForm,
  type RepoEntry,
  RepoItem,
  SecretsForm,
  serializeEnvSecrets,
  serializeFileSecrets,
  serializeRepos,
} from "@/components/workspace-form";

import {
  type DevCommand,
  DevCommandsForm,
} from "@/components/workspace-form/dev-commands-form";

interface EditWorkspaceDialogProps {
  workspace: Workspace;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

function parseWorkspaceRepos(
  repos: Workspace["config"]["repos"] | undefined,
): RepoEntry[] {
  if (!repos) return [];
  return repos.map((r) => {
    if ("sourceId" in r) {
      return {
        sourceId: r.sourceId,
        repo: r.repo,
        branch: r.branch,
        clonePath: r.clonePath,
      };
    }
    return {
      url: r.url,
      branch: r.branch,
      clonePath: r.clonePath,
    };
  });
}

export function EditWorkspaceDialog({
  workspace,
  open,
  onOpenChange,
}: EditWorkspaceDialogProps) {
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
  const updateMutation = useUpdateWorkspace();

  const [formData, setFormData] = useState({
    name: workspace.name,
    baseImage: workspace.config.baseImage,
    vcpus: workspace.config.vcpus,
    memoryMb: workspace.config.memoryMb,
    initCommands: workspace.config.initCommands.join("\n"),
    startCommands: workspace.config.startCommands.join("\n"),
  });

  const [repos, setRepos] = useState<RepoEntry[]>(() =>
    parseWorkspaceRepos(workspace.config.repos),
  );
  const [showAddRepo, setShowAddRepo] = useState(false);

  const [envSecrets, setEnvSecrets] = useState<EnvSecret[]>(() =>
    parseEnvSecrets(workspace.config.secrets || {}),
  );
  const [fileSecrets, setFileSecrets] = useState<FileSecretInput[]>(() =>
    parseFileSecrets(workspace.config.fileSecrets),
  );

  const [devCommands, setDevCommands] = useState<DevCommand[]>(
    () => (workspace.config.devCommands || []) as DevCommand[],
  );

  const isGitHubConnected = githubStatus?.connected === true;

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
            repos: serializeRepos(repos),
            secrets: serializeEnvSecrets(envSecrets),
            fileSecrets: serializeFileSecrets(fileSecrets),
            devCommands,
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
      <DialogContent className="sm:max-w-2xl max-h-[90vh] overflow-y-auto">
        <form onSubmit={handleSubmit}>
          <DialogHeader>
            <DialogTitle>Edit Workspace</DialogTitle>
            <DialogDescription>
              Update workspace configuration
            </DialogDescription>
          </DialogHeader>

          <Tabs defaultValue="general" className="mt-4">
            <TabsList className="grid w-full grid-cols-5">
              <TabsTrigger value="general">General</TabsTrigger>
              <TabsTrigger value="repos">Repos</TabsTrigger>
              <TabsTrigger value="commands">Commands</TabsTrigger>
              <TabsTrigger value="dev-commands">Dev Commands</TabsTrigger>
              <TabsTrigger value="secrets">Secrets</TabsTrigger>
            </TabsList>

            <TabsContent value="general" className="pt-4">
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
            </TabsContent>

            <TabsContent value="repos" className="space-y-4 pt-4">
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <Label>Repositories</Label>
                  {!showAddRepo && (
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => setShowAddRepo(true)}
                    >
                      <Plus className="h-4 w-4 mr-1" />
                      Add Repository
                    </Button>
                  )}
                </div>

                {repos.length === 0 && !showAddRepo ? (
                  <p className="text-sm text-muted-foreground">
                    No repositories configured
                  </p>
                ) : (
                  <div className="space-y-3">
                    {repos.map((repo, idx) => (
                      <RepoItem
                        key={
                          repo.url ||
                          (repo.sourceId && repo.repo
                            ? `${repo.sourceId}:${repo.repo}`
                            : `new-${idx}`)
                        }
                        repo={repo}
                        variant="card"
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

                {showAddRepo && (
                  <div className="border rounded-lg p-3 bg-muted/50">
                    <RepoAddForm
                      isGitHubConnected={isGitHubConnected}
                      gitSources={gitSources}
                      showCancel
                      onCancel={() => setShowAddRepo(false)}
                      onAdd={(repo) => {
                        setRepos([...repos, repo]);
                        setShowAddRepo(false);
                      }}
                    />
                  </div>
                )}
              </div>
            </TabsContent>

            <TabsContent value="commands" className="pt-4">
              <CommandsForm
                initCommands={formData.initCommands}
                startCommands={formData.startCommands}
                onInitCommandsChange={(initCommands) =>
                  setFormData({ ...formData, initCommands })
                }
                onStartCommandsChange={(startCommands) =>
                  setFormData({ ...formData, startCommands })
                }
              />
            </TabsContent>

            <TabsContent value="dev-commands" className="pt-4">
              <DevCommandsForm
                devCommands={devCommands}
                onChange={setDevCommands}
              />
            </TabsContent>

            <TabsContent value="secrets" className="pt-4">
              <SecretsForm
                envSecrets={envSecrets}
                fileSecrets={fileSecrets}
                onEnvSecretsChange={setEnvSecrets}
                onFileSecretsChange={setFileSecrets}
              />
            </TabsContent>
          </Tabs>

          <DialogFooter className="mt-6">
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
