import type { SessionTemplate } from "@frak-sandbox/shared/constants";
import { useQuery } from "@tanstack/react-query";
import {
  AlertTriangle,
  ChevronDown,
  ChevronRight,
  Loader2,
  Pencil,
  Plus,
  Trash2,
} from "lucide-react";
import { useMemo, useState } from "react";
import {
  type SessionTemplateInput,
  useUpdateWorkspaceSessionTemplates,
  workspaceOpenCodeConfigQuery,
  workspaceSessionTemplatesOverrideQuery,
} from "@/api/queries";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
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

interface WorkspaceSessionTemplatesSectionProps {
  workspaceId: string;
}

export function WorkspaceSessionTemplatesSection({
  workspaceId,
}: WorkspaceSessionTemplatesSectionProps) {
  const { data: templatesData, isLoading: templatesLoading } = useQuery(
    workspaceSessionTemplatesOverrideQuery(workspaceId),
  );
  const { data: openCodeConfig, isLoading: configLoading } = useQuery(
    workspaceOpenCodeConfigQuery(workspaceId),
  );
  const updateMutation = useUpdateWorkspaceSessionTemplates();

  const [editingTemplate, setEditingTemplate] =
    useState<SessionTemplate | null>(null);
  const [expandedTemplates, setExpandedTemplates] = useState<Set<string>>(
    new Set(),
  );

  const templates = templatesData?.templates ?? [];
  const isLoading = templatesLoading || configLoading;
  const hasSandbox = openCodeConfig?.available === true;

  const toggleExpanded = (id: string) => {
    setExpandedTemplates((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  const handleSaveTemplate = (updated: SessionTemplate) => {
    const newTemplates = templates.some((t) => t.id === updated.id)
      ? templates.map((t) => (t.id === updated.id ? updated : t))
      : [...templates, updated];
    updateMutation.mutate(
      { workspaceId, templates: newTemplates as SessionTemplateInput[] },
      { onSuccess: () => setEditingTemplate(null) },
    );
  };

  const handleDeleteTemplate = (id: string) => {
    if (!confirm("Delete this template override?")) return;
    const newTemplates = templates.filter((t) => t.id !== id);
    updateMutation.mutate({
      workspaceId,
      templates: newTemplates as SessionTemplateInput[],
    });
  };

  const handleAddTemplate = () => {
    const newTemplate: SessionTemplate = {
      id: `ws-template-${Date.now()}`,
      name: "New Template",
      category: "primary",
      description: "",
      variants: [
        {
          name: "Default",
          model: { providerID: "anthropic", modelID: "claude-sonnet-4-5" },
          variant: "high",
          agent: "Sisyphus",
        },
      ],
      defaultVariantIndex: 0,
    };
    setEditingTemplate(newTemplate);
  };

  if (isLoading) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Session Templates</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex items-center justify-center py-8">
            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <div>
            <CardTitle>Session Templates</CardTitle>
            <p className="text-sm text-muted-foreground mt-1">
              Workspace-specific template overrides
            </p>
          </div>
          <Button onClick={handleAddTemplate} disabled={!hasSandbox} size="sm">
            <Plus className="h-4 w-4 mr-2" />
            Add Template
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {!hasSandbox && (
          <div className="flex items-start gap-3 p-4 rounded-lg bg-yellow-500/10 border border-yellow-500/20">
            <AlertTriangle className="h-5 w-5 text-yellow-500 shrink-0 mt-0.5" />
            <div>
              <p className="font-medium text-yellow-600 dark:text-yellow-400">
                No running sandbox
              </p>
              <p className="text-sm text-muted-foreground mt-1">
                Start a sandbox for this workspace to configure templates with
                auto-discovery of providers, models, and agents.
              </p>
            </div>
          </div>
        )}

        {templates.length === 0 ? (
          <p className="text-muted-foreground text-sm py-4 text-center">
            No workspace-specific templates. Global templates will be used.
          </p>
        ) : (
          <div className="space-y-3">
            {templates.map((template) => {
              const isExpanded = expandedTemplates.has(template.id);
              return (
                <div key={template.id} className="border rounded-lg">
                  <div className="p-3 flex items-center justify-between">
                    <button
                      type="button"
                      onClick={() => toggleExpanded(template.id)}
                      className="flex items-center gap-2 text-left flex-1"
                    >
                      {isExpanded ? (
                        <ChevronDown className="h-4 w-4" />
                      ) : (
                        <ChevronRight className="h-4 w-4" />
                      )}
                      <div>
                        <span className="font-medium">{template.name}</span>
                        {template.description && (
                          <p className="text-sm text-muted-foreground">
                            {template.description}
                          </p>
                        )}
                      </div>
                    </button>
                    <div className="flex items-center gap-1">
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={() => setEditingTemplate(template)}
                        disabled={!hasSandbox}
                      >
                        <Pencil className="h-4 w-4" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={() => handleDeleteTemplate(template.id)}
                      >
                        <Trash2 className="h-4 w-4 text-destructive" />
                      </Button>
                    </div>
                  </div>
                  {isExpanded && (
                    <div className="px-3 pb-3 space-y-2">
                      {template.variants.map((variant, idx) => (
                        <div
                          key={variant.name}
                          className={`p-3 rounded-md border ${
                            idx === (template.defaultVariantIndex ?? 0)
                              ? "border-primary bg-primary/5"
                              : "border-border"
                          }`}
                        >
                          <div className="flex items-center justify-between">
                            <span className="font-medium">{variant.name}</span>
                            {idx === (template.defaultVariantIndex ?? 0) && (
                              <span className="text-xs text-primary">
                                Default
                              </span>
                            )}
                          </div>
                          <div className="text-sm text-muted-foreground mt-1 space-y-0.5">
                            <p>
                              Model: {variant.model.providerID}/
                              {variant.model.modelID}
                            </p>
                            {variant.variant && (
                              <p>Variant: {variant.variant}</p>
                            )}
                            {variant.agent && <p>Agent: {variant.agent}</p>}
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}

        <WorkspaceTemplateEditDialog
          template={editingTemplate}
          openCodeConfig={openCodeConfig ?? undefined}
          onClose={() => setEditingTemplate(null)}
          onSave={handleSaveTemplate}
          isNew={
            editingTemplate
              ? !templates.some((t) => t.id === editingTemplate.id)
              : false
          }
          isSaving={updateMutation.isPending}
        />
      </CardContent>
    </Card>
  );
}

interface OpenCodeConfig {
  available: boolean;
  sandboxId?: string;
  providers?: Array<{
    id: string;
    name: string;
    models: Record<
      string,
      { id: string; name: string; variants?: Record<string, unknown> }
    >;
  }>;
  agents?: Array<{ name: string; description?: string; mode: string }>;
}

interface WorkspaceTemplateEditDialogProps {
  template: SessionTemplate | null;
  openCodeConfig: OpenCodeConfig | undefined;
  onClose: () => void;
  onSave: (template: SessionTemplate) => void;
  isNew: boolean;
  isSaving: boolean;
}

function WorkspaceTemplateEditDialog({
  template,
  openCodeConfig,
  onClose,
  onSave,
  isNew,
  isSaving,
}: WorkspaceTemplateEditDialogProps) {
  const [editData, setEditData] = useState<SessionTemplate | null>(null);

  const data = editData ?? template;
  const providers = openCodeConfig?.providers ?? [];
  const agents = openCodeConfig?.agents ?? [];

  const providerOptions = useMemo(
    () => providers.map((p) => ({ value: p.id, label: p.name })),
    [providers],
  );

  const getModelOptions = (providerID: string) => {
    const provider = providers.find((p) => p.id === providerID);
    if (!provider) return [];
    return Object.entries(provider.models).map(([, model]) => ({
      value: model.id,
      label: model.name,
      variants: model.variants,
    }));
  };

  const getVariantOptions = (providerID: string, modelID: string) => {
    const provider = providers.find((p) => p.id === providerID);
    if (!provider) return ["standard", "high", "max"];
    const model = Object.values(provider.models).find((m) => m.id === modelID);
    if (!model?.variants || Object.keys(model.variants).length === 0) {
      return ["standard", "high", "max"];
    }
    return Object.keys(model.variants);
  };

  const agentOptions = useMemo(
    () => agents.map((a) => ({ value: a.name, label: a.name })),
    [agents],
  );

  if (!template) return null;

  const handleOpen = () => {
    setEditData({ ...template });
  };

  const handleSave = () => {
    if (!data) return;
    onSave(data);
  };

  const updateVariant = (
    idx: number,
    field: keyof SessionTemplate["variants"][number],
    value: string | { providerID: string; modelID: string },
  ) => {
    if (!data) return;
    const newVariants = data.variants.map((v, i) =>
      i === idx ? { ...v, [field]: value } : v,
    );
    setEditData({ ...data, variants: newVariants });
  };

  const addVariant = () => {
    if (!data) return;
    const firstProvider = providers[0];
    const firstModel = firstProvider
      ? Object.values(firstProvider.models)[0]
      : null;
    setEditData({
      ...data,
      variants: [
        ...data.variants,
        {
          name: `Variant ${data.variants.length + 1}`,
          model: {
            providerID: firstProvider?.id ?? "anthropic",
            modelID: firstModel?.id ?? "claude-sonnet-4-5",
          },
          variant: "high",
          agent: agents[0]?.name ?? "Sisyphus",
        },
      ],
    });
  };

  const removeVariant = (idx: number) => {
    if (!data || data.variants.length <= 1) return;
    const newVariants = data.variants.filter((_, i) => i !== idx);
    const newDefault =
      data.defaultVariantIndex === idx
        ? 0
        : (data.defaultVariantIndex ?? 0) > idx
          ? (data.defaultVariantIndex ?? 0) - 1
          : data.defaultVariantIndex;
    setEditData({
      ...data,
      variants: newVariants,
      defaultVariantIndex: newDefault,
    });
  };

  return (
    <Dialog
      open={!!template}
      onOpenChange={(open) => {
        if (!open) onClose();
        else handleOpen();
      }}
    >
      <DialogContent className="max-w-2xl max-h-[80vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>
            {isNew ? "Create Template" : "Edit Template"}
          </DialogTitle>
          <DialogDescription>
            Configure the template with dynamic model and agent options
          </DialogDescription>
        </DialogHeader>

        {data && (
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label>Template ID</Label>
                <Input
                  value={data.id}
                  onChange={(e) => setEditData({ ...data, id: e.target.value })}
                  disabled={!isNew}
                  className="font-mono"
                />
              </div>
              <div className="space-y-2">
                <Label>Name</Label>
                <Input
                  value={data.name}
                  onChange={(e) =>
                    setEditData({ ...data, name: e.target.value })
                  }
                />
              </div>
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label>Category</Label>
                <Select
                  value={data.category}
                  onValueChange={(v) =>
                    setEditData({
                      ...data,
                      category: v as "primary" | "secondary",
                    })
                  }
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="primary">Primary</SelectItem>
                    <SelectItem value="secondary">Secondary</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label>Description</Label>
                <Input
                  value={data.description ?? ""}
                  onChange={(e) =>
                    setEditData({ ...data, description: e.target.value })
                  }
                  placeholder="Optional description"
                />
              </div>
            </div>

            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <Label>Variants</Label>
                <Button variant="outline" size="sm" onClick={addVariant}>
                  <Plus className="h-3 w-3 mr-1" />
                  Add Variant
                </Button>
              </div>

              <div className="space-y-3">
                {data.variants.map((variant, idx) => {
                  const modelOptions = getModelOptions(
                    variant.model.providerID,
                  );
                  const variantOptions = getVariantOptions(
                    variant.model.providerID,
                    variant.model.modelID,
                  );

                  return (
                    <div
                      key={`variant-${idx}-${variant.name}`}
                      className="p-3 border rounded-md space-y-3"
                    >
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-2">
                          <Input
                            value={variant.name}
                            onChange={(e) =>
                              updateVariant(idx, "name", e.target.value)
                            }
                            className="w-40"
                            placeholder="Variant name"
                          />
                          <label className="flex items-center gap-1.5 text-sm">
                            <input
                              type="radio"
                              name="defaultVariant"
                              checked={idx === (data.defaultVariantIndex ?? 0)}
                              onChange={() =>
                                setEditData({
                                  ...data,
                                  defaultVariantIndex: idx,
                                })
                              }
                              className="h-4 w-4"
                            />
                            Default
                          </label>
                        </div>
                        {data.variants.length > 1 && (
                          <Button
                            variant="ghost"
                            size="icon"
                            onClick={() => removeVariant(idx)}
                          >
                            <Trash2 className="h-4 w-4 text-destructive" />
                          </Button>
                        )}
                      </div>

                      <div className="grid grid-cols-2 gap-3">
                        <div className="space-y-1.5">
                          <Label className="text-xs">Provider</Label>
                          {providerOptions.length > 0 ? (
                            <Select
                              value={variant.model.providerID}
                              onValueChange={(v) =>
                                updateVariant(idx, "model", {
                                  providerID: v,
                                  modelID:
                                    getModelOptions(v)[0]?.value ??
                                    variant.model.modelID,
                                })
                              }
                            >
                              <SelectTrigger>
                                <SelectValue />
                              </SelectTrigger>
                              <SelectContent>
                                {providerOptions.map((opt) => (
                                  <SelectItem key={opt.value} value={opt.value}>
                                    {opt.label}
                                  </SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                          ) : (
                            <Input
                              value={variant.model.providerID}
                              onChange={(e) =>
                                updateVariant(idx, "model", {
                                  ...variant.model,
                                  providerID: e.target.value,
                                })
                              }
                              placeholder="anthropic"
                              className="font-mono text-sm"
                            />
                          )}
                        </div>
                        <div className="space-y-1.5">
                          <Label className="text-xs">Model</Label>
                          {modelOptions.length > 0 ? (
                            <Select
                              value={variant.model.modelID}
                              onValueChange={(v) =>
                                updateVariant(idx, "model", {
                                  ...variant.model,
                                  modelID: v,
                                })
                              }
                            >
                              <SelectTrigger>
                                <SelectValue />
                              </SelectTrigger>
                              <SelectContent>
                                {modelOptions.map((opt) => (
                                  <SelectItem key={opt.value} value={opt.value}>
                                    {opt.label}
                                  </SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                          ) : (
                            <Input
                              value={variant.model.modelID}
                              onChange={(e) =>
                                updateVariant(idx, "model", {
                                  ...variant.model,
                                  modelID: e.target.value,
                                })
                              }
                              placeholder="claude-sonnet-4-5"
                              className="font-mono text-sm"
                            />
                          )}
                        </div>
                        <div className="space-y-1.5">
                          <Label className="text-xs">Variant</Label>
                          <Select
                            value={variant.variant ?? "high"}
                            onValueChange={(v) =>
                              updateVariant(idx, "variant", v)
                            }
                          >
                            <SelectTrigger>
                              <SelectValue placeholder="Select variant" />
                            </SelectTrigger>
                            <SelectContent>
                              {variantOptions.map((v) => (
                                <SelectItem key={v} value={v}>
                                  {v}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        </div>
                        <div className="space-y-1.5">
                          <Label className="text-xs">Agent</Label>
                          {agentOptions.length > 0 ? (
                            <Select
                              value={variant.agent ?? ""}
                              onValueChange={(v) =>
                                updateVariant(idx, "agent", v)
                              }
                            >
                              <SelectTrigger>
                                <SelectValue placeholder="Select agent" />
                              </SelectTrigger>
                              <SelectContent>
                                {agentOptions.map((opt) => (
                                  <SelectItem key={opt.value} value={opt.value}>
                                    {opt.label}
                                  </SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                          ) : (
                            <Input
                              value={variant.agent ?? ""}
                              onChange={(e) =>
                                updateVariant(idx, "agent", e.target.value)
                              }
                              placeholder="Sisyphus"
                            />
                          )}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={handleSave} disabled={isSaving}>
            {isSaving ? (
              <>
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                Saving...
              </>
            ) : isNew ? (
              "Create"
            ) : (
              "Save"
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
