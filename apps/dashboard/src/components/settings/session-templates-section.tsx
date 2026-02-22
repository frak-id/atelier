import type { SessionTemplate } from "@frak/atelier-shared/constants";
import { useQuery } from "@tanstack/react-query";
import { ChevronDown, ChevronRight, Pencil, Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import {
  globalOpenCodeConfigQuery,
  globalSessionTemplatesQuery,
  useUpdateGlobalSessionTemplates,
} from "@/api/queries";
import { SessionTemplateEditDialog } from "@/components/session-template-edit-dialog";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export function SessionTemplatesSection() {
  const { data, isLoading } = useQuery(globalSessionTemplatesQuery);
  const { data: openCodeConfig } = useQuery(globalOpenCodeConfigQuery);
  const updateMutation = useUpdateGlobalSessionTemplates();
  const [editingTemplate, setEditingTemplate] =
    useState<SessionTemplate | null>(null);
  const [expandedTemplates, setExpandedTemplates] = useState<Set<string>>(
    new Set(),
  );

  if (isLoading) {
    return (
      <div className="border-t pt-6">
        <h2 className="text-xl font-bold mb-4">Task Templates</h2>
        <div className="animate-pulse h-32 bg-muted rounded" />
      </div>
    );
  }

  const templates = data?.templates ?? [];
  const isNew = editingTemplate
    ? !templates.some((t) => t.id === editingTemplate.id)
    : false;

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
    const newTemplates = isNew
      ? [...templates, updated]
      : templates.map((t) => (t.id === updated.id ? updated : t));
    updateMutation.mutate(newTemplates, {
      onSuccess: () => setEditingTemplate(null),
    });
  };

  const handleDeleteTemplate = (id: string) => {
    if (!confirm("Delete this template?")) return;
    const newTemplates = templates.filter((t) => t.id !== id);
    updateMutation.mutate(newTemplates);
  };

  const handleAddTemplate = () => {
    const newTemplate: SessionTemplate = {
      id: `template-${Date.now()}`,
      name: "New Template",
      category: "primary",
      description: "",
      variants: [
        {
          name: "Default",
          model: { providerID: "anthropic", modelID: "claude-sonnet-4-5" },
          variant: "high",
          agent: "build",
        },
      ],
      defaultVariantIndex: 0,
    };
    setEditingTemplate(newTemplate);
  };

  return (
    <div className="border-t pt-6">
      <div className="flex items-center justify-between mb-4">
        <div>
          <h2 className="text-xl font-bold">Task Templates</h2>
          <p className="text-muted-foreground text-sm">
            Configure AI model and agent settings for tasks
          </p>
        </div>
        <Button onClick={handleAddTemplate}>
          <Plus className="h-4 w-4 mr-2" />
          Add Template
        </Button>
      </div>

      {templates.length === 0 ? (
        <Card>
          <CardContent className="py-8 text-center text-muted-foreground">
            No task templates configured. Using system defaults.
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-3">
          {templates.map((template) => {
            const isExpanded = expandedTemplates.has(template.id);
            return (
              <Card key={template.id}>
                <CardHeader className="pb-2">
                  <div className="flex items-center justify-between">
                    <button
                      type="button"
                      onClick={() => toggleExpanded(template.id)}
                      className="flex items-center gap-2 text-left"
                    >
                      {isExpanded ? (
                        <ChevronDown className="h-4 w-4" />
                      ) : (
                        <ChevronRight className="h-4 w-4" />
                      )}
                      <CardTitle className="text-base">
                        {template.name}
                      </CardTitle>
                    </button>
                    <div className="flex items-center gap-1">
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={() => setEditingTemplate(template)}
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
                  {template.description && (
                    <p className="text-sm text-muted-foreground ml-6">
                      {template.description}
                    </p>
                  )}
                </CardHeader>
                {isExpanded && (
                  <CardContent>
                    <div className="space-y-2">
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
                  </CardContent>
                )}
              </Card>
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
    </div>
  );
}
