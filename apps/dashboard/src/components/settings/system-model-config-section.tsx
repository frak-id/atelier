import type {
  SystemModelConfig,
  SystemModelRef,
} from "@frak/atelier-manager/types";
import { useQuery } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import { useEffect, useState } from "react";
import {
  globalOpenCodeConfigQuery,
  systemModelConfigQuery,
  useUpdateSystemModelConfig,
} from "@/api/queries";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

const MODEL_FIELDS = [
  {
    key: "default" as const,
    label: "Default Model",
    description: "Fallback model used when no action-specific model is set",
  },
  {
    key: "title" as const,
    label: "Title Generation",
    description:
      "Generates short titles for tasks and workspaces from descriptions",
  },
  {
    key: "description" as const,
    label: "Description Generation",
    description: "Analyzes workspace repos to generate technical descriptions",
  },
  {
    key: "dispatcher" as const,
    label: "Dispatcher",
    description:
      "Routes integration events (Slack/GitHub) to the right workspace and task",
  },
] as const;

export function SystemModelConfigSection() {
  const { data: savedConfig, isLoading } = useQuery(systemModelConfigQuery);
  const { data: openCodeConfig } = useQuery(globalOpenCodeConfigQuery);
  const updateMutation = useUpdateSystemModelConfig();

  const [config, setConfig] = useState<SystemModelConfig>({
    default: null,
    title: null,
    description: null,
    dispatcher: null,
  });
  const [hasChanges, setHasChanges] = useState(false);

  useEffect(() => {
    if (savedConfig) {
      const next: SystemModelConfig = {
        default: savedConfig.default ?? null,
        title: savedConfig.title ?? null,
        description: savedConfig.description ?? null,
        dispatcher: savedConfig.dispatcher ?? null,
      };
      setConfig(next);
      setHasChanges(false);
    }
  }, [savedConfig]);

  const providers = openCodeConfig?.providers ?? [];
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
    }));
  };

  const updateField = (
    key: (typeof MODEL_FIELDS)[number]["key"],
    value: SystemModelRef | null,
  ) => {
    setConfig((prev) => ({ ...prev, [key]: value }));
    setHasChanges(true);
  };

  const handleSave = () => {
    updateMutation.mutate(config, {
      onSuccess: () => setHasChanges(false),
    });
  };

  if (isLoading) {
    return (
      <div className="border-t pt-6">
        <h2 className="text-xl font-bold mb-4">System Model Config</h2>
        <div className="animate-pulse h-32 bg-muted rounded" />
      </div>
    );
  }

  return (
    <div className="border-t pt-6">
      <div className="mb-4">
        <h2 className="text-xl font-bold">System Model Config</h2>
        <p className="text-muted-foreground text-sm">
          Configure which AI models are used for system actions like title
          generation and event dispatching.
        </p>
      </div>

      <Card>
        <CardContent className="pt-6 space-y-6">
          {MODEL_FIELDS.map((field) => {
            const value = config[field.key];
            const defaultModel = config.default;
            const isActionField = field.key !== "default";
            const showDefaultHint = isActionField && !value && defaultModel;

            return (
              <div key={field.key} className="space-y-2">
                <div className="flex items-center justify-between">
                  <div>
                    <Label className="text-sm font-medium">{field.label}</Label>
                    <p className="text-xs text-muted-foreground">
                      {field.description}
                    </p>
                  </div>
                  {value && (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => updateField(field.key, null)}
                    >
                      Clear
                    </Button>
                  )}
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <div className="space-y-1.5">
                    <Label className="text-xs">Provider</Label>
                    {providerOptions.length > 0 ? (
                      <Select
                        value={value?.providerID ?? ""}
                        onValueChange={(v) => {
                          const firstModel = getModelOptions(v)[0];
                          updateField(field.key, {
                            providerID: v,
                            modelID: firstModel?.value ?? value?.modelID ?? "",
                          });
                        }}
                      >
                        <SelectTrigger>
                          <SelectValue
                            placeholder={
                              showDefaultHint
                                ? `Using default: ${defaultModel.providerID}`
                                : "(OpenCode default)"
                            }
                          />
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
                        value={value?.providerID ?? ""}
                        onChange={(e) =>
                          updateField(field.key, {
                            providerID: e.target.value,
                            modelID: value?.modelID ?? "",
                          })
                        }
                        placeholder={
                          showDefaultHint
                            ? `Using default: ${defaultModel.providerID}`
                            : "(OpenCode default)"
                        }
                        className="font-mono text-sm"
                      />
                    )}
                  </div>

                  <div className="space-y-1.5">
                    <Label className="text-xs">Model</Label>
                    {providerOptions.length > 0 && value?.providerID ? (
                      <Select
                        value={value?.modelID ?? ""}
                        onValueChange={(v) =>
                          updateField(field.key, {
                            providerID: value?.providerID ?? "",
                            modelID: v,
                          })
                        }
                      >
                        <SelectTrigger>
                          <SelectValue
                            placeholder={
                              showDefaultHint
                                ? `Using default: ${defaultModel.modelID}`
                                : "(OpenCode default)"
                            }
                          />
                        </SelectTrigger>
                        <SelectContent>
                          {getModelOptions(value.providerID).map((opt) => (
                            <SelectItem key={opt.value} value={opt.value}>
                              {opt.label}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    ) : (
                      <Input
                        value={value?.modelID ?? ""}
                        onChange={(e) =>
                          updateField(field.key, {
                            providerID: value?.providerID ?? "",
                            modelID: e.target.value,
                          })
                        }
                        placeholder={
                          showDefaultHint
                            ? `Using default: ${defaultModel.modelID}`
                            : "(OpenCode default)"
                        }
                        className="font-mono text-sm"
                      />
                    )}
                  </div>
                </div>

                {showDefaultHint && (
                  <p className="text-xs text-muted-foreground">
                    Using default: {defaultModel.providerID}/
                    {defaultModel.modelID}
                  </p>
                )}
              </div>
            );
          })}

          <div className="flex justify-end pt-2">
            <Button
              onClick={handleSave}
              disabled={!hasChanges || updateMutation.isPending}
            >
              {updateMutation.isPending ? (
                <>
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  Saving...
                </>
              ) : (
                "Save"
              )}
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
