import { useForm, useStore } from "@tanstack/react-form";
import { useQuery, useSuspenseQuery } from "@tanstack/react-query";
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

  const form = useForm({
    defaultValues: {
      name: "",
      baseImage: "dev-base",
      vcpus: 2,
      memoryMb: 2048,
      initCommands: "",
      repos: [] as RepoEntry[],
    },
    onSubmit: async ({ value }) => {
      createMutation.mutate(
        {
          name: value.name,
          config: {
            baseImage: value.baseImage,
            vcpus: value.vcpus,
            memoryMb: value.memoryMb,
            initCommands: value.initCommands
              .split("\n")
              .filter((cmd: string) => cmd.trim()),
            repos: serializeRepos(value.repos),
            secrets: {},
            exposedPorts: [],
          },
        },
        {
          onSuccess: () => {
            onOpenChange(false);
            form.reset();
          },
        },
      );
    },
  });

  const isGitHubConnected = githubStatus?.connected === true;
  const values = useStore(form.store, (s) => s.values);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg max-h-[90vh] overflow-y-auto">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            form.handleSubmit();
          }}
        >
          <DialogHeader>
            <DialogTitle>Create Workspace</DialogTitle>
            <DialogDescription>
              Configure a new workspace for sandbox development
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <GeneralForm
              name={values.name}
              baseImage={values.baseImage}
              vcpus={values.vcpus}
              memoryMb={values.memoryMb}
              images={images ?? []}
              onNameChange={(v) => form.setFieldValue("name", v)}
              onBaseImageChange={(v) => form.setFieldValue("baseImage", v)}
              onVcpusChange={(v) => form.setFieldValue("vcpus", v)}
              onMemoryMbChange={(v) => form.setFieldValue("memoryMb", v)}
            />

            <div className="space-y-2">
              <Label>Repositories</Label>
              {values.repos.length > 0 && (
                <div className="space-y-3 mb-2">
                  {values.repos.map((repo, idx) => (
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
                        form.setFieldValue(
                          "repos",
                          values.repos.map((r, i) =>
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
                          values.repos.filter((_, i) => i !== idx),
                        )
                      }
                    />
                  ))}
                </div>
              )}
              <RepoAddForm
                isGitHubConnected={isGitHubConnected}
                gitSources={gitSources}
                onAdd={(repo) =>
                  form.setFieldValue("repos", [...values.repos, repo])
                }
                onRepoSelected={(repoName) => {
                  if (!values.name) {
                    form.setFieldValue("name", repoName);
                  }
                }}
              />
            </div>

            <CommandsForm
              initCommands={values.initCommands}
              onInitCommandsChange={(v) =>
                form.setFieldValue("initCommands", v)
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
            <form.Subscribe selector={(state) => state.isSubmitting}>
              {(isSubmitting) => (
                <Button
                  type="submit"
                  disabled={isSubmitting || createMutation.isPending}
                >
                  {isSubmitting || createMutation.isPending
                    ? "Creating..."
                    : "Create"}
                </Button>
              )}
            </form.Subscribe>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
