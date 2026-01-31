import { useForm, useStore } from "@tanstack/react-form";
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

interface WorkspaceFormValues {
  name: string;
  baseImage: string;
  vcpus: number;
  memoryMb: number;
  initCommands: string;
  useRegistryCache: boolean;
  repos: RepoEntry[];
  envSecrets: EnvSecret[];
  fileSecrets: FileSecretInput[];
  devCommands: DevCommand[];
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

  const [showAddRepo, setShowAddRepo] = useState(false);

  const form = useForm({
    defaultValues: {
      name: workspace.name,
      baseImage: workspace.config.baseImage,
      vcpus: workspace.config.vcpus,
      memoryMb: workspace.config.memoryMb,
      initCommands: workspace.config.initCommands.join("\n"),
      useRegistryCache: (workspace.config.useRegistryCache as boolean) ?? true,
      repos: parseWorkspaceRepos(workspace.config.repos),
      envSecrets: parseEnvSecrets(workspace.config.secrets || {}),
      fileSecrets: parseFileSecrets(workspace.config.fileSecrets),
      devCommands: (workspace.config.devCommands || []) as DevCommand[],
    } satisfies WorkspaceFormValues,
    onSubmit: async ({ value }) => {
      updateMutation.mutate(
        {
          id: workspace.id,
          data: {
            name: value.name,
            config: {
              ...workspace.config,
              baseImage: value.baseImage,
              vcpus: value.vcpus,
              memoryMb: value.memoryMb,
              useRegistryCache: value.useRegistryCache,
              initCommands: value.initCommands
                .split("\n")
                .filter((cmd: string) => cmd.trim()),
              repos: serializeRepos(value.repos),
              secrets: serializeEnvSecrets(value.envSecrets),
              fileSecrets: serializeFileSecrets(value.fileSecrets),
              devCommands: value.devCommands.map(({ id, ...cmd }) => ({
                ...cmd,
                extraPorts: cmd.extraPorts
                  ?.map(({ id: _epId, ...ep }) => ep)
                  .filter((ep) => ep.alias && ep.port),
              })),
            },
          },
        },
        {
          onSuccess: () => onOpenChange(false),
        },
      );
    },
  });

  const isGitHubConnected = githubStatus?.connected === true;

  const name = useStore(form.store, (s) => s.values.name);
  const baseImage = useStore(form.store, (s) => s.values.baseImage);
  const vcpus = useStore(form.store, (s) => s.values.vcpus);
  const memoryMb = useStore(form.store, (s) => s.values.memoryMb);
  const initCommands = useStore(form.store, (s) => s.values.initCommands);
  const useRegistryCache = useStore(
    form.store,
    (s) => s.values.useRegistryCache,
  );
  const repos = useStore(form.store, (s) => s.values.repos);
  const envSecrets = useStore(form.store, (s) => s.values.envSecrets);
  const fileSecrets = useStore(form.store, (s) => s.values.fileSecrets);
  const devCommands = useStore(form.store, (s) => s.values.devCommands);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl max-h-[90vh] overflow-y-auto">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            form.handleSubmit();
          }}
        >
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
                name={name}
                baseImage={baseImage}
                vcpus={vcpus}
                memoryMb={memoryMb}
                images={images ?? []}
                onNameChange={(v) => form.setFieldValue("name", v)}
                onBaseImageChange={(v) => form.setFieldValue("baseImage", v)}
                onVcpusChange={(v) => form.setFieldValue("vcpus", v)}
                onMemoryMbChange={(v) => form.setFieldValue("memoryMb", v)}
                useRegistryCache={useRegistryCache}
                onUseRegistryCacheChange={(v) =>
                  form.setFieldValue("useRegistryCache", v)
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
                          form.setFieldValue(
                            "repos",
                            repos.map((r, i) =>
                              i === idx
                                ? {
                                    ...r,
                                    ...updates,
                                  }
                                : r,
                            ),
                          )
                        }
                        onRemove={() =>
                          form.setFieldValue(
                            "repos",
                            repos.filter((_, i) => i !== idx),
                          )
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
                        form.setFieldValue("repos", [...repos, repo]);
                        setShowAddRepo(false);
                      }}
                    />
                  </div>
                )}
              </div>
            </TabsContent>

            <TabsContent value="commands" className="pt-4">
              <CommandsForm
                initCommands={initCommands}
                onInitCommandsChange={(v) =>
                  form.setFieldValue("initCommands", v)
                }
              />
            </TabsContent>

            <TabsContent value="dev-commands" className="pt-4">
              <DevCommandsForm
                devCommands={devCommands}
                onChange={(v) => form.setFieldValue("devCommands", v)}
              />
            </TabsContent>

            <TabsContent value="secrets" className="pt-4">
              <SecretsForm
                envSecrets={envSecrets}
                fileSecrets={fileSecrets}
                onEnvSecretsChange={(v) => form.setFieldValue("envSecrets", v)}
                onFileSecretsChange={(v) =>
                  form.setFieldValue("fileSecrets", v)
                }
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
            <form.Subscribe selector={(state) => state.isSubmitting}>
              {(isSubmitting) => (
                <Button
                  type="submit"
                  disabled={isSubmitting || updateMutation.isPending}
                >
                  {isSubmitting || updateMutation.isPending
                    ? "Saving..."
                    : "Save"}
                </Button>
              )}
            </form.Subscribe>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
