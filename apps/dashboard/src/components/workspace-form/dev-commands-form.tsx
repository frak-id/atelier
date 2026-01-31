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
export interface ExtraPort {
  id?: string;
  port: number | undefined;
  alias: string;
}

export interface DevCommand {
  id?: string;
  name: string;
  command: string;
  port?: number;
  extraPorts?: ExtraPort[];
  workdir?: string;
  env?: Record<string, string>;
  isDefault?: boolean;
}

interface DevCommandsFormProps {
  devCommands: DevCommand[];
  onChange: (commands: DevCommand[]) => void;
}

export function DevCommandsForm({
  devCommands,
  onChange,
}: DevCommandsFormProps) {
  const [expandedEnvs, setExpandedEnvs] = useState<Record<string, boolean>>({});

  const handleAdd = () => {
    onChange([
      ...devCommands,
      {
        id: crypto.randomUUID(),
        name: "",
        command: "",
        env: {},
        isDefault: false,
      },
    ]);
  };

  const handleRemove = (index: number) => {
    onChange(devCommands.filter((_, i) => i !== index));
  };

  const handleChange = <K extends keyof DevCommand>(
    index: number,
    field: K,
    value: DevCommand[K],
  ) => {
    const updated = [...devCommands];
    updated[index] = { ...updated[index], [field]: value } as DevCommand;

    if (field === "isDefault" && value === true) {
      updated.forEach((cmd, i) => {
        if (i !== index && cmd.isDefault) {
          updated[i] = { ...cmd, isDefault: false };
        }
      });
    }

    onChange(updated);
  };

  const handleAddExtraPort = (cmdIndex: number) => {
    const updated = [...devCommands];
    const cmd = updated[cmdIndex];
    if (!cmd) return;
    const currentExtra = cmd.extraPorts ?? [];
    updated[cmdIndex] = {
      ...cmd,
      extraPorts: [
        ...currentExtra,
        { id: crypto.randomUUID(), port: undefined, alias: "" },
      ],
    };
    onChange(updated);
  };

  const handleRemoveExtraPort = (cmdIndex: number, epIndex: number) => {
    const updated = [...devCommands];
    const cmd = updated[cmdIndex];
    if (!cmd) return;
    updated[cmdIndex] = {
      ...cmd,
      extraPorts: (cmd.extraPorts ?? []).filter((_, i) => i !== epIndex),
    };
    onChange(updated);
  };

  const handleExtraPortChange = (
    cmdIndex: number,
    epIndex: number,
    field: "port" | "alias",
    value: number | string | undefined,
  ) => {
    const updated = [...devCommands];
    const cmd = updated[cmdIndex];
    if (!cmd) return;
    const extraPorts = [...(cmd.extraPorts ?? [])];
    const existing = extraPorts[epIndex];
    if (!existing) return;
    extraPorts[epIndex] = { ...existing, [field]: value } as ExtraPort;
    updated[cmdIndex] = { ...cmd, extraPorts };
    onChange(updated);
  };

  const [expandedExtraPorts, setExpandedExtraPorts] = useState<
    Record<string, boolean>
  >({});

  const toggleExtraPortsExpanded = (id: string) => {
    setExpandedExtraPorts((prev) => ({ ...prev, [id]: !prev[id] }));
  };

  const isValidAlias = (alias: string) => /^[a-z0-9-]{1,20}$/.test(alias);
  const isValidAliasInput = (alias: string) => /^[a-z0-9-]{0,20}$/.test(alias);

  const handleEnvChange = (index: number, envSecrets: EnvSecret[]) => {
    const updated = [...devCommands];
    updated[index] = {
      ...updated[index],
      env: serializeEnvSecrets(envSecrets),
    } as DevCommand;
    onChange(updated);
  };

  const toggleEnvExpanded = (id: string) => {
    setExpandedEnvs((prev) => ({
      ...prev,
      [id]: !prev[id],
    }));
  };

  const isValidNameInput = (name: string) => /^[a-z0-9-]{0,20}$/.test(name);
  const isValidName = (name: string) => /^[a-z0-9-]{1,20}$/.test(name);

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
            const cmdId = cmd.id || `fallback-${index}`;
            const portError =
              cmd.port !== undefined && cmd.port > 0 && cmd.port < 1024
                ? "Port must be 1024 or higher"
                : null;

            const nameError = !isValidName(cmd.name)
              ? "Name required: 1-20 lowercase alphanumeric chars or dashes"
              : null;

            return (
              <Card key={cmdId}>
                <CardContent className="pt-6 space-y-4">
                  <div className="grid grid-cols-2 gap-4">
                    <div className="space-y-2">
                      <Label className="text-xs">Name</Label>
                      <Input
                        value={cmd.name}
                        onChange={(e) => {
                          if (isValidNameInput(e.target.value)) {
                            handleChange(index, "name", e.target.value);
                          }
                        }}
                        placeholder="e.g. dev-server"
                        className={nameError ? "border-destructive" : ""}
                        aria-invalid={!!nameError}
                        aria-describedby={
                          nameError ? `name-error-${cmdId}` : undefined
                        }
                      />
                      {nameError && (
                        <p
                          id={`name-error-${cmdId}`}
                          className="text-[10px] text-destructive"
                          role="alert"
                        >
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
                          if (!e.target.value) {
                            handleChange(index, "port", undefined);
                            return;
                          }
                          const parsed = parseInt(e.target.value, 10);
                          // Allow any valid number while typing, validate range on blur
                          if (
                            !Number.isNaN(parsed) &&
                            parsed >= 0 &&
                            parsed <= 65535
                          ) {
                            handleChange(index, "port", parsed);
                          }
                        }}
                        onBlur={() => {
                          // Clear invalid ports on blur
                          if (cmd.port !== undefined && cmd.port < 1024) {
                            handleChange(index, "port", undefined);
                          }
                        }}
                        placeholder="3000"
                        min={1024}
                        max={65535}
                        aria-invalid={!!portError}
                        aria-describedby={
                          portError ? `port-error-${cmdId}` : undefined
                        }
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
                    <div
                      id={`port-error-${cmdId}`}
                      className="flex items-center gap-2 p-2 border border-destructive/50 rounded-md bg-destructive/10 text-destructive text-xs"
                      role="alert"
                    >
                      <AlertCircle className="h-4 w-4" />
                      <span>{portError}</span>
                    </div>
                  )}

                  <div className="flex items-center space-x-2">
                    <Checkbox
                      id={`default-${cmdId}`}
                      checked={cmd.isDefault || false}
                      onChange={(e) =>
                        handleChange(
                          index,
                          "isDefault",
                          (e.target as HTMLInputElement).checked,
                        )
                      }
                    />
                    <Label
                      htmlFor={`default-${cmdId}`}
                      className="text-sm font-normal cursor-pointer"
                    >
                      Set as default command
                    </Label>
                  </div>

                  <Collapsible
                    open={expandedExtraPorts[cmdId]}
                    onOpenChange={() => toggleExtraPortsExpanded(cmdId)}
                    className="border rounded-md p-2"
                  >
                    <div className="flex items-center justify-between">
                      <Label className="text-xs text-muted-foreground">
                        Extra Ports
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
                              expandedExtraPorts[cmdId] ? "rotate-45" : ""
                            }`}
                          />
                        </Button>
                      </CollapsibleTrigger>
                    </div>
                    <CollapsibleContent className="pt-2 space-y-2">
                      {(cmd.extraPorts ?? []).map((ep, epIdx) => {
                        const epId = ep.id || `ep-fallback-${epIdx}`;
                        const aliasError =
                          ep.alias && !isValidAlias(ep.alias)
                            ? "1-20 lowercase alphanumeric or dashes"
                            : null;
                        const epPortError =
                          ep.port !== undefined && ep.port > 0 && ep.port < 1024
                            ? "Port must be 1024 or higher"
                            : null;
                        return (
                          <div key={epId} className="flex items-center gap-2">
                            <Input
                              value={ep.alias}
                              onChange={(e) => {
                                if (isValidAliasInput(e.target.value)) {
                                  handleExtraPortChange(
                                    index,
                                    epIdx,
                                    "alias",
                                    e.target.value,
                                  );
                                }
                              }}
                              placeholder="alias"
                              className={`flex-1 ${aliasError ? "border-destructive" : ""}`}
                            />
                            <Input
                              type="number"
                              value={ep.port ?? ""}
                              onChange={(e) => {
                                if (!e.target.value) {
                                  handleExtraPortChange(
                                    index,
                                    epIdx,
                                    "port",
                                    undefined,
                                  );
                                  return;
                                }
                                const parsed = parseInt(e.target.value, 10);
                                if (
                                  !Number.isNaN(parsed) &&
                                  parsed >= 0 &&
                                  parsed <= 65535
                                ) {
                                  handleExtraPortChange(
                                    index,
                                    epIdx,
                                    "port",
                                    parsed,
                                  );
                                }
                              }}
                              placeholder="port"
                              min={1024}
                              max={65535}
                              className={`w-24 ${epPortError ? "border-destructive" : ""}`}
                            />
                            <Button
                              type="button"
                              variant="ghost"
                              size="sm"
                              className="h-8 w-8 p-0 text-destructive hover:text-destructive"
                              onClick={() =>
                                handleRemoveExtraPort(index, epIdx)
                              }
                            >
                              <Trash2 className="h-3 w-3" />
                            </Button>
                          </div>
                        );
                      })}
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        className="w-full"
                        onClick={() => handleAddExtraPort(index)}
                      >
                        <Plus className="h-3 w-3 mr-1" />
                        Add Port
                      </Button>
                    </CollapsibleContent>
                  </Collapsible>

                  <Collapsible
                    open={expandedEnvs[cmdId]}
                    onOpenChange={() => toggleEnvExpanded(cmdId)}
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
                              expandedEnvs[cmdId] ? "rotate-45" : ""
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
