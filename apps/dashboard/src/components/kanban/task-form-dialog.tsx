import type { RepoConfig, Task } from "@frak-sandbox/manager/types";
import { DEFAULT_SESSION_TEMPLATES } from "@frak-sandbox/shared/constants";
import { useQuery } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import {
  githubBranchesQuery,
  useCreateTask,
  useUpdateTask,
  workspaceDetailQuery,
  workspaceSessionTemplatesQuery,
} from "@/api/queries";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
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

function parseGitHubRepo(
  repo: RepoConfig,
): { owner: string; repo: string } | null {
  if ("repo" in repo) {
    const parts = repo.repo.split("/");
    if (parts.length === 2 && parts[0] && parts[1]) {
      return { owner: parts[0], repo: parts[1] };
    }
  }

  if ("url" in repo) {
    const match = repo.url.match(/github\.com[/:]([^/]+)\/([^/.]+)/);
    if (match?.[1] && match[2]) {
      return { owner: match[1], repo: match[2] };
    }
  }

  return null;
}

type TaskFormDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  workspaceId: string;
  task?: Task;
};

export function TaskFormDialog({
  open,
  onOpenChange,
  workspaceId,
  task,
}: TaskFormDialogProps) {
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [context, setContext] = useState("");
  const [selectedRepoIndices, setSelectedRepoIndices] = useState<number[]>([]);
  const [selectedBranch, setSelectedBranch] = useState<string>("");

  const { data: workspace } = useQuery(workspaceDetailQuery(workspaceId));
  const { data: templateData } = useQuery(
    workspaceSessionTemplatesQuery(workspaceId),
  );
  const allTemplates = templateData?.templates ?? DEFAULT_SESSION_TEMPLATES;
  const templates = allTemplates.filter((t) => t.category === "primary");
  const defaultTemplate = templates[0];
  const [selectedTemplateId, setSelectedTemplateId] = useState(
    defaultTemplate?.id ?? "",
  );
  const [selectedVariantIndex, setSelectedVariantIndex] = useState(
    defaultTemplate?.defaultVariantIndex ?? 0,
  );

  const selectedTemplate = templates.find((t) => t.id === selectedTemplateId);
  const createMutation = useCreateTask();
  const updateMutation = useUpdateTask();

  const isEditing = !!task;
  const isPending = createMutation.isPending || updateMutation.isPending;

  const repos = workspace?.config?.repos ?? [];
  const hasMultipleRepos = repos.length > 1;

  const effectiveTargetRepos = useMemo(() => {
    if (repos.length === 0) return [];
    if (repos.length === 1) return [repos[0]];
    if (selectedRepoIndices.length === 0) return repos;
    return selectedRepoIndices.map((i) => repos[i]).filter(Boolean);
  }, [repos, selectedRepoIndices]);

  const singleTargetRepo =
    effectiveTargetRepos.length === 1 ? effectiveTargetRepos[0] : null;
  const gitHubInfo = singleTargetRepo
    ? parseGitHubRepo(singleTargetRepo)
    : null;

  const { data: branchesData } = useQuery(
    githubBranchesQuery(gitHubInfo?.owner ?? "", gitHubInfo?.repo ?? ""),
  );

  useEffect(() => {
    if (open) {
      if (task) {
        setTitle(task.title);
        setDescription(task.data.description ?? "");
        setContext(task.data.context ?? "");
        setSelectedTemplateId(
          task.data.workflowId ?? defaultTemplate?.id ?? "",
        );
        setSelectedVariantIndex(
          task.data.variantIndex ?? defaultTemplate?.defaultVariantIndex ?? 0,
        );
        setSelectedRepoIndices(task.data.targetRepoIndices ?? []);
        setSelectedBranch(task.data.baseBranch ?? "");
      } else {
        setTitle("");
        setDescription("");
        setContext("");
        setSelectedTemplateId(defaultTemplate?.id ?? "");
        setSelectedVariantIndex(defaultTemplate?.defaultVariantIndex ?? 0);
        setSelectedRepoIndices([]);
        setSelectedBranch("");
      }
    }
  }, [open, task, defaultTemplate]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!title.trim() || !description.trim()) return;

    if (isEditing && task) {
      await updateMutation.mutateAsync({
        id: task.id,
        data: {
          title: title.trim(),
          description: description.trim(),
          context: context.trim() || undefined,
          workflowId: selectedTemplateId || undefined,
          variantIndex: selectedVariantIndex,
        } as Parameters<typeof updateMutation.mutateAsync>[0]["data"],
      });
    } else {
      await createMutation.mutateAsync({
        workspaceId,
        title: title.trim(),
        description: description.trim(),
        context: context.trim() || undefined,
        workflowId: selectedTemplateId || undefined,
        variantIndex: selectedVariantIndex,
        baseBranch: selectedBranch || undefined,
        targetRepoIndices:
          selectedRepoIndices.length > 0 ? selectedRepoIndices : undefined,
      } as Parameters<typeof createMutation.mutateAsync>[0]);
    }

    onOpenChange(false);
  };

  const toggleRepoSelection = (index: number) => {
    setSelectedRepoIndices((prev) =>
      prev.includes(index) ? prev.filter((i) => i !== index) : [...prev, index],
    );
  };

  const handleTemplateChange = (templateId: string) => {
    setSelectedTemplateId(templateId);
    const template = templates.find((t) => t.id === templateId);
    setSelectedVariantIndex(template?.defaultVariantIndex ?? 0);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[500px]">
        <form onSubmit={handleSubmit}>
          <DialogHeader>
            <DialogTitle>{isEditing ? "Edit Task" : "Create Task"}</DialogTitle>
            <DialogDescription>
              {isEditing
                ? "Update the task details below."
                : "Describe what you want the AI to work on."}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label htmlFor="title">Title</Label>
              <Input
                id="title"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="e.g., Implement user authentication"
                autoFocus
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="description">Description</Label>
              <Textarea
                id="description"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="Describe the task in detail. This will be sent to the AI as the initial prompt."
                rows={5}
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="context">
                Additional Context{" "}
                <span className="text-muted-foreground">(optional)</span>
              </Label>
              <Textarea
                id="context"
                value={context}
                onChange={(e) => setContext(e.target.value)}
                placeholder="Documentation links, API references, or any other helpful context."
                rows={3}
              />
            </div>

            <div className="space-y-2">
              <Label>Configuration</Label>
              <div className="flex gap-2">
                {templates.length > 1 && (
                  <Select
                    value={selectedTemplateId}
                    onValueChange={handleTemplateChange}
                  >
                    <SelectTrigger className="flex-1">
                      <SelectValue placeholder="Template" />
                    </SelectTrigger>
                    <SelectContent>
                      {templates.map((template) => (
                        <SelectItem key={template.id} value={template.id}>
                          {template.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}

                {selectedTemplate && selectedTemplate.variants.length > 0 && (
                  <Select
                    value={String(selectedVariantIndex)}
                    onValueChange={(v) => setSelectedVariantIndex(Number(v))}
                  >
                    <SelectTrigger className="flex-1">
                      <SelectValue placeholder="Effort" />
                    </SelectTrigger>
                    <SelectContent>
                      {selectedTemplate.variants.map((variant, idx) => (
                        <SelectItem key={idx} value={String(idx)}>
                          {variant.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
              </div>
            </div>

            {!isEditing && hasMultipleRepos && (
              <div className="space-y-2">
                <Label>
                  Target Repositories{" "}
                  <span className="text-muted-foreground">
                    (optional, defaults to all)
                  </span>
                </Label>
                <div className="space-y-2 rounded-md border p-3">
                  {repos.map((repo, index) => (
                    <div
                      key={repo.clonePath}
                      className="flex items-center gap-2"
                    >
                      <Checkbox
                        id={`repo-${index}`}
                        checked={selectedRepoIndices.includes(index)}
                        onChange={() => toggleRepoSelection(index)}
                      />
                      <label
                        htmlFor={`repo-${index}`}
                        className="text-sm font-mono cursor-pointer"
                      >
                        {repo.clonePath}
                      </label>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {!isEditing && singleTargetRepo && gitHubInfo && (
              <div className="space-y-2">
                <Label>
                  Base Branch{" "}
                  <span className="text-muted-foreground">(optional)</span>
                </Label>
                <Select
                  value={selectedBranch}
                  onValueChange={setSelectedBranch}
                >
                  <SelectTrigger>
                    <SelectValue
                      placeholder={
                        branchesData?.defaultBranch
                          ? `Default: ${branchesData.defaultBranch}`
                          : "Select branch..."
                      }
                    />
                  </SelectTrigger>
                  <SelectContent>
                    {branchesData?.branches.map((branch) => (
                      <SelectItem key={branch.name} value={branch.name}>
                        {branch.name}
                        {branch.isDefault && (
                          <span className="text-muted-foreground ml-2">
                            (default)
                          </span>
                        )}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}
          </div>

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={isPending || !title.trim() || !description.trim()}
            >
              {isPending && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
              {isEditing ? "Save Changes" : "Create Task"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
