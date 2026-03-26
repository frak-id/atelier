import { useForm, useStore } from "@tanstack/react-form";
import { useSuspenseQuery } from "@tanstack/react-query";
import { imageListQuery, useCreateWorkspace } from "@/api/queries";
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
  const createMutation = useCreateWorkspace();

  const form = useForm({
    defaultValues: {
      name: "",
      description: "",
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
            description: value.description || undefined,
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

  const name = useStore(form.store, (s) => s.values.name);
  const description = useStore(form.store, (s) => s.values.description);
  const baseImage = useStore(form.store, (s) => s.values.baseImage);
  const vcpus = useStore(form.store, (s) => s.values.vcpus);
  const memoryMb = useStore(form.store, (s) => s.values.memoryMb);
  const initCommands = useStore(form.store, (s) => s.values.initCommands);
  const repos = useStore(form.store, (s) => s.values.repos);

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
              name={name}
              description={description}
              baseImage={baseImage}
              vcpus={vcpus}
              memoryMb={memoryMb}
              images={images ?? []}
              onNameChange={(v) => form.setFieldValue("name", v)}
              onDescriptionChange={(v) => form.setFieldValue("description", v)}
              onBaseImageChange={(v) => form.setFieldValue("baseImage", v)}
              onVcpusChange={(v) => form.setFieldValue("vcpus", v)}
              onMemoryMbChange={(v) => form.setFieldValue("memoryMb", v)}
            />

            <div className="space-y-2">
              <Label>Repositories</Label>
              {repos.length > 0 && (
                <div className="space-y-3 mb-2">
                  {repos.map((repo, idx) => (
                    <RepoItem
                      key={repo.url || `new-${idx}`}
                      repo={repo}
                      variant="muted"
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
              <RepoAddForm
                onAdd={(repo) => form.setFieldValue("repos", [...repos, repo])}
                onRepoSelected={(repoName) => {
                  if (!name) {
                    form.setFieldValue("name", repoName);
                  }
                }}
              />
            </div>

            <CommandsForm
              initCommands={initCommands}
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
