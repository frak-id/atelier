import type { RepoConfig, Task } from "@frak-sandbox/manager/types";
import { DEFAULT_SESSION_TEMPLATES } from "@frak-sandbox/shared/constants";
import { useForm, useStore } from "@tanstack/react-form";
import { useQuery } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import { useMemo } from "react";
import {
  githubBranchesQuery,
  useCreateTask,
  useUpdateTask,
  workspaceDetailQuery,
  workspaceListQuery,
  workspaceSessionTemplatesQuery,
} from "@/api/queries";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
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

export type TaskFormProps = {
  workspaceId?: string;
  task?: Task;
  onSuccess?: () => void;
  showWorkspaceSelector?: boolean;
};

export function TaskForm({
  workspaceId: fixedWorkspaceId,
  task,
  onSuccess,
  showWorkspaceSelector: forceShowWorkspaceSelector,
}: TaskFormProps) {
  const isEditing = !!task;
  const showWorkspaceSelector =
    forceShowWorkspaceSelector ?? (!fixedWorkspaceId && !task);

  const createMutation = useCreateTask();
  const updateMutation = useUpdateTask();
  const isPending = createMutation.isPending || updateMutation.isPending;

  const form = useForm({
    defaultValues: {
      title: task?.title ?? "",
      description: task?.data.description ?? "",
      context: task?.data.context ?? "",
      selectedRepoIndices: task?.data.targetRepoIndices ?? ([] as number[]),
      selectedBranch: task?.data.baseBranch ?? "",
      selectedWorkspaceId: "",
      selectedTemplateId: task?.data.workflowId ?? "",
      selectedVariantIndex: task?.data.variantIndex ?? 0,
    },
    onSubmit: async ({ value }) => {
      const workspaceId = fixedWorkspaceId || value.selectedWorkspaceId;
      if (!workspaceId) return;

      if (isEditing && task) {
        await updateMutation.mutateAsync({
          id: task.id,
          data: {
            title: value.title.trim(),
            description: value.description.trim(),
            context: value.context.trim() || undefined,
            workflowId: value.selectedTemplateId || undefined,
            variantIndex: value.selectedVariantIndex,
          } as Parameters<typeof updateMutation.mutateAsync>[0]["data"],
        });
      } else {
        await createMutation.mutateAsync({
          workspaceId,
          title: value.title.trim(),
          description: value.description.trim(),
          context: value.context.trim() || undefined,
          workflowId: value.selectedTemplateId || undefined,
          variantIndex: value.selectedVariantIndex,
          baseBranch: value.selectedBranch || undefined,
          targetRepoIndices:
            value.selectedRepoIndices.length > 0
              ? value.selectedRepoIndices
              : undefined,
        } as Parameters<typeof createMutation.mutateAsync>[0]);
      }

      form.reset();
      onSuccess?.();
    },
  });

  const values = useStore(form.store, (s) => s.values);
  const workspaceId = fixedWorkspaceId || values.selectedWorkspaceId;

  const { data: workspaces } = useQuery({
    ...workspaceListQuery(),
    enabled: showWorkspaceSelector,
  });

  const { data: workspace } = useQuery({
    ...workspaceDetailQuery(workspaceId),
    enabled: !!workspaceId,
  });
  const { data: templateData } = useQuery({
    ...workspaceSessionTemplatesQuery(workspaceId),
    enabled: !!workspaceId,
  });
  const allTemplates = templateData?.templates ?? DEFAULT_SESSION_TEMPLATES;
  const templates = allTemplates.filter((t) => t.category === "primary");

  const selectedTemplate = templates.find(
    (t) => t.id === values.selectedTemplateId,
  );

  const repos = workspace?.config?.repos ?? [];
  const hasMultipleRepos = repos.length > 1;

  const effectiveTargetRepos = useMemo(() => {
    if (repos.length === 0) return [];
    if (repos.length === 1) return [repos[0]];
    if (values.selectedRepoIndices.length === 0) return repos;
    return values.selectedRepoIndices.map((i) => repos[i]).filter(Boolean);
  }, [repos, values.selectedRepoIndices]);

  const singleTargetRepo =
    effectiveTargetRepos.length === 1 ? effectiveTargetRepos[0] : null;
  const gitHubInfo = singleTargetRepo
    ? parseGitHubRepo(singleTargetRepo)
    : null;

  const { data: branchesData } = useQuery(
    githubBranchesQuery(gitHubInfo?.owner ?? "", gitHubInfo?.repo ?? ""),
  );

  const canSubmit =
    !isPending &&
    !!values.title.trim() &&
    !!values.description.trim() &&
    !!workspaceId;

  const toggleRepoSelection = (index: number) => {
    const prev = values.selectedRepoIndices;
    form.setFieldValue(
      "selectedRepoIndices",
      prev.includes(index) ? prev.filter((i) => i !== index) : [...prev, index],
    );
  };

  const handleTemplateChange = (templateId: string) => {
    form.setFieldValue("selectedTemplateId", templateId);
    const template = templates.find((t) => t.id === templateId);
    form.setFieldValue(
      "selectedVariantIndex",
      template?.defaultVariantIndex ?? 0,
    );
  };

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        form.handleSubmit();
      }}
      className="space-y-4"
    >
      {showWorkspaceSelector && (
        <div className="space-y-2">
          <Label>Workspace</Label>
          <Select
            value={values.selectedWorkspaceId}
            onValueChange={(v) => form.setFieldValue("selectedWorkspaceId", v)}
          >
            <SelectTrigger>
              <SelectValue placeholder="Select workspace..." />
            </SelectTrigger>
            <SelectContent>
              {workspaces?.map((ws) => (
                <SelectItem key={ws.id} value={ws.id}>
                  {ws.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      )}

      <div className="space-y-2">
        <Label htmlFor="title">Title</Label>
        <Input
          id="title"
          value={values.title}
          onChange={(e) => form.setFieldValue("title", e.target.value)}
          placeholder="e.g., Implement user authentication"
        />
      </div>

      <div className="space-y-2">
        <Label htmlFor="description">Description</Label>
        <Textarea
          id="description"
          value={values.description}
          onChange={(e) => form.setFieldValue("description", e.target.value)}
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
          value={values.context}
          onChange={(e) => form.setFieldValue("context", e.target.value)}
          placeholder="Documentation links, API references, or any other helpful context."
          rows={3}
        />
      </div>

      <div className="space-y-2">
        <Label>Configuration</Label>
        <div className="flex gap-2">
          {templates.length > 1 && (
            <Select
              value={values.selectedTemplateId}
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
              value={String(values.selectedVariantIndex)}
              onValueChange={(v) =>
                form.setFieldValue("selectedVariantIndex", Number(v))
              }
            >
              <SelectTrigger className="flex-1">
                <SelectValue placeholder="Effort" />
              </SelectTrigger>
              <SelectContent>
                {selectedTemplate.variants.map((variant, idx) => (
                  <SelectItem key={variant.name} value={String(idx)}>
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
              <div key={repo.clonePath} className="flex items-center gap-2">
                <Checkbox
                  id={`repo-${index}`}
                  checked={values.selectedRepoIndices.includes(index)}
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
            value={values.selectedBranch}
            onValueChange={(v) => form.setFieldValue("selectedBranch", v)}
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

      <Button type="submit" disabled={!canSubmit} className="w-full">
        {isPending && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
        {isEditing ? "Save Changes" : "Create Task"}
      </Button>
    </form>
  );
}

type TaskFormDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  workspaceId?: string;
  task?: Task;
};

export function TaskFormDialog({
  open,
  onOpenChange,
  workspaceId,
  task,
}: TaskFormDialogProps) {
  const isEditing = !!task;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[500px]">
        <DialogHeader>
          <DialogTitle>{isEditing ? "Edit Task" : "Create Task"}</DialogTitle>
          <DialogDescription>
            {isEditing
              ? "Update the task details below."
              : "Describe what you want the AI to work on."}
          </DialogDescription>
        </DialogHeader>

        <TaskForm
          workspaceId={workspaceId}
          task={task}
          onSuccess={() => onOpenChange(false)}
        />
      </DialogContent>
    </Dialog>
  );
}
