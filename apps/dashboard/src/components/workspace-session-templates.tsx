import type { SessionTemplate } from "@frak-sandbox/shared/constants";
import { useQuery } from "@tanstack/react-query";
import {
  AlertTriangle,
  ChevronDown,
  ChevronRight,
  Copy,
  Globe,
  Loader2,
  Pencil,
  Plus,
  Trash2,
} from "lucide-react";
import { useState } from "react";
import {
  globalSessionTemplatesQuery,
  type SessionTemplateInput,
  useUpdateWorkspaceSessionTemplates,
  workspaceOpenCodeConfigQuery,
  workspaceSessionTemplatesOverrideQuery,
} from "@/api/queries";
import { SessionTemplateEditDialog } from "@/components/session-template-edit-dialog";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

interface WorkspaceSessionTemplatesSectionProps {
  workspaceId: string;
}

export function WorkspaceSessionTemplatesSection({
  workspaceId,
}: WorkspaceSessionTemplatesSectionProps) {
  const { data: templatesData, isLoading: templatesLoading } = useQuery(
    workspaceSessionTemplatesOverrideQuery(workspaceId),
  );
  const { data: globalData, isLoading: globalLoading } = useQuery(
    globalSessionTemplatesQuery,
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
  const globalTemplates = globalData?.templates ?? [];
  const overriddenIds = new Set(templates.map((t) => t.id));
  const nonOverriddenGlobalTemplates = globalTemplates.filter(
    (t) => !overriddenIds.has(t.id),
  );
  const isLoading = templatesLoading || configLoading || globalLoading;
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

  const isNew = editingTemplate
    ? !templates.some((t) => t.id === editingTemplate.id)
    : false;

  const handleSaveTemplate = (updated: SessionTemplate) => {
    const newTemplates = isNew
      ? [...templates, updated]
      : templates.map((t) => (t.id === updated.id ? updated : t));
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

  const handleOverrideGlobal = (globalTemplate: SessionTemplate) => {
    const overrideTemplate: SessionTemplate = {
      ...globalTemplate,
      variants: globalTemplate.variants.map((v) => ({ ...v })),
    };
    setEditingTemplate(overrideTemplate);
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

        {templates.length === 0 && nonOverriddenGlobalTemplates.length === 0 ? (
          <p className="text-muted-foreground text-sm py-4 text-center">
            No templates configured.
          </p>
        ) : templates.length === 0 ? null : (
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

        {nonOverriddenGlobalTemplates.length > 0 && (
          <div className="space-y-3">
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Globe className="h-4 w-4" />
              <span>Global Templates</span>
            </div>
            {nonOverriddenGlobalTemplates.map((template) => {
              const isExpanded = expandedTemplates.has(`global-${template.id}`);
              return (
                <div
                  key={template.id}
                  className="border rounded-lg border-dashed opacity-60 hover:opacity-100 transition-opacity"
                >
                  <div className="p-3 flex items-center justify-between">
                    <button
                      type="button"
                      onClick={() => toggleExpanded(`global-${template.id}`)}
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
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => handleOverrideGlobal(template)}
                      disabled={!hasSandbox}
                    >
                      <Copy className="h-3 w-3 mr-1.5" />
                      Override
                    </Button>
                  </div>
                  {isExpanded && (
                    <div className="px-3 pb-3 space-y-2">
                      {template.variants.map((variant, idx) => (
                        <div
                          key={`global-${template.id}-${idx}`}
                          className={`p-3 rounded-md border ${
                            idx === (template.defaultVariantIndex ?? 0)
                              ? "border-primary/50 bg-primary/5"
                              : "border-border"
                          }`}
                        >
                          <div className="flex items-center justify-between">
                            <span className="font-medium">{variant.name}</span>
                            {idx === (template.defaultVariantIndex ?? 0) && (
                              <span className="text-xs text-primary/70">
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

        <SessionTemplateEditDialog
          template={editingTemplate}
          openCodeConfig={openCodeConfig ?? undefined}
          onClose={() => setEditingTemplate(null)}
          onSave={handleSaveTemplate}
          isNew={isNew}
          isSaving={updateMutation.isPending}
        />
      </CardContent>
    </Card>
  );
}
