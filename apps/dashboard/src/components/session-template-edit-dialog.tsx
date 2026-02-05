import type { SessionTemplate } from "@frak/atelier-shared/constants";
import { Loader2, Plus, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
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

export interface OpenCodeConfig {
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

interface SessionTemplateEditDialogProps {
  template: SessionTemplate | null;
  openCodeConfig: OpenCodeConfig | undefined;
  onClose: () => void;
  onSave: (template: SessionTemplate) => void;
  isNew: boolean;
  isSaving: boolean;
}

export function SessionTemplateEditDialog({
  template,
  openCodeConfig,
  onClose,
  onSave,
  isNew,
  isSaving,
}: SessionTemplateEditDialogProps) {
  const [editData, setEditData] = useState<SessionTemplate | null>(null);

  useEffect(() => {
    if (template) {
      setEditData({ ...template });
    } else {
      setEditData(null);
    }
  }, [template]);

  const data = editData ?? template;
  const providers = openCodeConfig?.providers ?? [];
  const agents = openCodeConfig?.agents ?? [];

  const providerOptions = providers.map((p) => ({
    value: p.id,
    label: p.name,
  }));

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

  const agentOptions = agents.map((a) => ({ value: a.name, label: a.name }));

  if (!template) return null;

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
      }}
    >
      <DialogContent className="max-w-2xl max-h-[80vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>
            {isNew ? "Create Template" : "Edit Template"}
          </DialogTitle>
          <DialogDescription>
            {openCodeConfig?.available
              ? "Configure the template with dynamic model and agent options"
              : "Configure the template (start a sandbox for auto-discovery)"}
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
                      key={`variant-${idx}`}
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
