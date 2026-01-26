import { AlertCircle, Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  type EnvSecret,
  EnvSecretsForm,
  parseEnvSecrets,
  serializeEnvSecrets,
} from "./env-secrets-form";

// Replicated from apps/manager/src/schemas/workspace.ts - Defined here to avoid direct dependency on manager source
export interface DevCommand {
  name: string;
  command: string;
  port?: number;
  workdir?: string;
  env?: Record<string, string>;
  isDefault?: boolean;
}

const FORBIDDEN_DEV_PORTS = [8080, 9999, 22, 7681, 4000];

interface DevCommandsFormProps {
  devCommands: DevCommand[];
  onChange: (commands: DevCommand[]) => void;
}

export function DevCommandsForm({
  devCommands,
  onChange,
}: DevCommandsFormProps) {
  const [expandedEnvs, setExpandedEnvs] = useState<Record<number, boolean>>({});

  const handleAdd = () => {
    onChange([
      ...devCommands,
      { name: "", command: "", env: {}, isDefault: false },
    ]);
  };

  const handleRemove = (index: number) => {
    onChange(devCommands.filter((_, i) => i !== index));
  };

  const handleChange = (index: number, field: keyof DevCommand, value: any) => {
    const updated = [...devCommands];
    // Cast is necessary because TypeScript infers partial type when spreading with dynamic key
    updated[index] = { ...updated[index], [field]: value } as DevCommand;

    // If setting isDefault to true, unset it for all others
    if (field === "isDefault" && value === true) {
      updated.forEach((cmd, i) => {
        if (i !== index && cmd.isDefault) {
          updated[i] = { ...cmd, isDefault: false };
        }
      });
    }

    onChange(updated);
  };

  const handleEnvChange = (index: number, envSecrets: EnvSecret[]) => {
    const updated = [...devCommands];
    updated[index] = {
      ...updated[index],
      env: serializeEnvSecrets(envSecrets),
    } as DevCommand;
    onChange(updated);
  };

  const toggleEnvExpanded = (index: number) => {
    setExpandedEnvs((prev) => ({
      ...prev,
      [index]: !prev[index],
    }));
  };

  const isForbiddenPort = (port: number) => FORBIDDEN_DEV_PORTS.includes(port);
  const isValidName = (name: string) => /^[a-z0-9-]{0,20}$/.test(name);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <Label>Dev Commands</Label>
        <Button type="button" onClick={handleAdd} size="sm" variant="outline">
          <Plus className="h-4 w-4 mr-1" />
          Add Command
        </Button>
      </div>

      {devCommands.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No dev commands configured
        </p>
      ) : (
        <div className="space-y-4">
          {devCommands.map((cmd, index) => {
            const portError =
              cmd.port && isForbiddenPort(cmd.port)
                ? `Port ${cmd.port} is reserved for system services`
                : null;

            const nameError =
              cmd.name && !/^[a-z0-9-]{1,20}$/.test(cmd.name)
                ? "Name must be 1-20 lowercase alphanumeric chars or dashes"
                : null;

            return (
              <Card key={index}>
                <CardContent className="pt-6 space-y-4">
                  <div className="grid grid-cols-2 gap-4">
                    <div className="space-y-2">
                      <Label className="text-xs">Name</Label>
                      <Input
                        value={cmd.name}
                        onChange={(e) => {
                          if (isValidName(e.target.value)) {
                            handleChange(index, "name", e.target.value);
                          }
                        }}
                        placeholder="e.g. dev-server"
                        className={nameError ? "border-destructive" : ""}
                      />
                      {nameError && (
                        <p className="text-[10px] text-destructive">
                          {nameError}
                        </p>
                      )}
                    </div>
                    <div className="space-y-2">
                      <Label className="text-xs">Command</Label>
                      <Input
                        value={cmd.command}
                        onChange={(e) =>
                          handleChange(index, "command", e.target.value)
                        }
                        placeholder="bun run dev"
                      />
                    </div>
                  </div>

                  <div className="grid grid-cols-2 gap-4">
                    <div className="space-y-2">
                      <Label className="text-xs">Port (Optional)</Label>
                      <Input
                        type="number"
                        value={cmd.port || ""}
                        onChange={(e) => {
                          const val = e.target.value
                            ? parseInt(e.target.value)
                            : undefined;
                          handleChange(index, "port", val);
                        }}
                        placeholder="3000"
                        min={1024}
                        max={65535}
                      />
                    </div>
                    <div className="space-y-2">
                      <Label className="text-xs">Workdir (Optional)</Label>
                      <Input
                        value={cmd.workdir || ""}
                        onChange={(e) =>
                          handleChange(index, "workdir", e.target.value)
                        }
                        placeholder="/home/dev/app"
                      />
                    </div>
                  </div>

                  {portError && (
                    <div className="flex items-center gap-2 p-2 border border-destructive/50 rounded-md bg-destructive/10 text-destructive text-xs">
                      <AlertCircle className="h-4 w-4" />
                      <span>{portError}</span>
                    </div>
                  )}

                  <div className="flex items-center space-x-2">
                    <Checkbox
                      id={`default-${index}`}
                      checked={cmd.isDefault || false}
                      onChange={(e) =>
                        handleChange(index, "isDefault", e.target.checked)
                      }
                    />
                    <Label
                      htmlFor={`default-${index}`}
                      className="text-sm font-normal cursor-pointer"
                    >
                      Set as default command
                    </Label>
                  </div>

                  <Collapsible
                    open={expandedEnvs[index]}
                    onOpenChange={() => toggleEnvExpanded(index)}
                    className="border rounded-md p-2"
                  >
                    <div className="flex items-center justify-between">
                      <Label className="text-xs text-muted-foreground">
                        Environment Variables
                      </Label>
                      <CollapsibleTrigger asChild>
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          className="h-6 w-6 p-0"
                        >
                          <Plus
                            className={`h-3 w-3 transition-transform ${
                              expandedEnvs[index] ? "rotate-45" : ""
                            }`}
                          />
                        </Button>
                      </CollapsibleTrigger>
                    </div>
                    <CollapsibleContent className="pt-2">
                      <EnvSecretsForm
                        secrets={parseEnvSecrets(cmd.env || {})}
                        onChange={(secrets) => handleEnvChange(index, secrets)}
                      />
                    </CollapsibleContent>
                  </Collapsible>

                  <div className="flex justify-end">
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() => handleRemove(index)}
                      className="text-destructive hover:text-destructive hover:bg-destructive/10"
                    >
                      <Trash2 className="h-4 w-4 mr-1" />
                      Remove Command
                    </Button>
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}
