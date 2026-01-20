import { useSuspenseQuery } from "@tanstack/react-query";
import { Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import type { FileSecret, Workspace } from "@/api/client";
import { imageListQuery, useUpdateWorkspace } from "@/api/queries";
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
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";

interface EditWorkspaceDialogProps {
  workspace: Workspace;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

interface EnvSecret {
  key: string;
  value: string;
}

interface FileSecretInput {
  name: string;
  path: string;
  content: string;
  mode: string;
}

const FILE_SECRET_PRESETS = [
  {
    id: "aws-credentials",
    name: "AWS Credentials",
    path: "~/.aws/credentials",
    placeholder: `[default]
aws_access_key_id = AKIA...
aws_secret_access_key = ...
region = us-east-1`,
  },
  {
    id: "gcp-service-account",
    name: "GCP Service Account",
    path: "~/.config/gcloud/application_default_credentials.json",
    placeholder: `{
  "type": "service_account",
  "project_id": "...",
  "private_key_id": "...",
  ...
}`,
  },
  {
    id: "kubeconfig",
    name: "Kubeconfig",
    path: "~/.kube/config",
    placeholder: `apiVersion: v1
kind: Config
clusters:
  - cluster:
      ...`,
  },
] as const;

function parseEnvSecrets(secrets: Record<string, string>): EnvSecret[] {
  return Object.entries(secrets).map(([key, value]) => ({ key, value }));
}

function serializeEnvSecrets(envSecrets: EnvSecret[]): Record<string, string> {
  const result: Record<string, string> = {};
  for (const { key, value } of envSecrets) {
    if (key.trim()) {
      result[key.trim()] = value;
    }
  }
  return result;
}

function parseFileSecrets(
  secrets: FileSecret[] | undefined,
): FileSecretInput[] {
  if (!secrets) return [];
  return secrets.map((s) => ({
    name: s.name,
    path: s.path,
    content: s.content,
    mode: s.mode || "0600",
  }));
}

function serializeFileSecrets(fileSecrets: FileSecretInput[]): FileSecret[] {
  return fileSecrets
    .filter((s) => s.name.trim() && s.path.trim() && s.content.trim())
    .map((s) => ({
      name: s.name.trim(),
      path: s.path.trim(),
      content: s.content,
      mode: s.mode || "0600",
    }));
}

export function EditWorkspaceDialog({
  workspace,
  open,
  onOpenChange,
}: EditWorkspaceDialogProps) {
  const { data: images } = useSuspenseQuery(imageListQuery());
  const updateMutation = useUpdateWorkspace();

  const [formData, setFormData] = useState({
    name: workspace.name,
    baseImage: workspace.config.baseImage,
    vcpus: workspace.config.vcpus,
    memoryMb: workspace.config.memoryMb,
    initCommands: workspace.config.initCommands.join("\n"),
    startCommands: workspace.config.startCommands.join("\n"),
  });

  const [envSecrets, setEnvSecrets] = useState<EnvSecret[]>(() =>
    parseEnvSecrets(workspace.config.secrets || {}),
  );

  const [fileSecrets, setFileSecrets] = useState<FileSecretInput[]>(() =>
    parseFileSecrets(workspace.config.fileSecrets),
  );

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    updateMutation.mutate(
      {
        id: workspace.id,
        data: {
          name: formData.name,
          config: {
            ...workspace.config,
            baseImage: formData.baseImage,
            vcpus: formData.vcpus,
            memoryMb: formData.memoryMb,
            initCommands: formData.initCommands
              .split("\n")
              .filter((cmd) => cmd.trim()),
            startCommands: formData.startCommands
              .split("\n")
              .filter((cmd) => cmd.trim()),
            secrets: serializeEnvSecrets(envSecrets),
            fileSecrets: serializeFileSecrets(fileSecrets),
          },
        },
      },
      {
        onSuccess: () => onOpenChange(false),
      },
    );
  };

  const addEnvSecret = () => {
    setEnvSecrets([...envSecrets, { key: "", value: "" }]);
  };

  const removeEnvSecret = (index: number) => {
    setEnvSecrets(envSecrets.filter((_, i) => i !== index));
  };

  const updateEnvSecret = (
    index: number,
    field: "key" | "value",
    value: string,
  ) => {
    setEnvSecrets((prev) =>
      prev.map((s, i) => (i === index ? { ...s, [field]: value } : s)),
    );
  };

  const addFileSecret = (presetId?: string) => {
    if (presetId) {
      const preset = FILE_SECRET_PRESETS.find((p) => p.id === presetId);
      if (preset) {
        setFileSecrets([
          ...fileSecrets,
          { name: preset.name, path: preset.path, content: "", mode: "0600" },
        ]);
        return;
      }
    }
    setFileSecrets([
      ...fileSecrets,
      { name: "", path: "", content: "", mode: "0600" },
    ]);
  };

  const removeFileSecret = (index: number) => {
    setFileSecrets(fileSecrets.filter((_, i) => i !== index));
  };

  const updateFileSecret = (
    index: number,
    field: keyof FileSecretInput,
    value: string,
  ) => {
    setFileSecrets((prev) =>
      prev.map((s, i) => (i === index ? { ...s, [field]: value } : s)),
    );
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl max-h-[90vh] overflow-y-auto">
        <form onSubmit={handleSubmit}>
          <DialogHeader>
            <DialogTitle>Edit Workspace</DialogTitle>
            <DialogDescription>
              Update workspace configuration
            </DialogDescription>
          </DialogHeader>

          <Tabs defaultValue="general" className="mt-4">
            <TabsList className="grid w-full grid-cols-3">
              <TabsTrigger value="general">General</TabsTrigger>
              <TabsTrigger value="commands">Commands</TabsTrigger>
              <TabsTrigger value="secrets">Secrets</TabsTrigger>
            </TabsList>

            <TabsContent value="general" className="space-y-4 pt-4">
              <div className="space-y-2">
                <Label htmlFor="name">Workspace Name</Label>
                <Input
                  id="name"
                  required
                  value={formData.name}
                  onChange={(e) =>
                    setFormData({ ...formData, name: e.target.value })
                  }
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="image">Base Image</Label>
                <Select
                  value={formData.baseImage}
                  onValueChange={(value) =>
                    setFormData({ ...formData, baseImage: value })
                  }
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {images?.map((image) => (
                      <SelectItem key={image.id} value={image.id}>
                        {image.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label htmlFor="vcpus">vCPUs</Label>
                  <Select
                    value={String(formData.vcpus)}
                    onValueChange={(value) =>
                      setFormData({ ...formData, vcpus: parseInt(value, 10) })
                    }
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="1">1 vCPU</SelectItem>
                      <SelectItem value="2">2 vCPUs</SelectItem>
                      <SelectItem value="4">4 vCPUs</SelectItem>
                      <SelectItem value="8">8 vCPUs</SelectItem>
                    </SelectContent>
                  </Select>
                </div>

                <div className="space-y-2">
                  <Label htmlFor="memory">Memory</Label>
                  <Select
                    value={String(formData.memoryMb)}
                    onValueChange={(value) =>
                      setFormData({
                        ...formData,
                        memoryMb: parseInt(value, 10),
                      })
                    }
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="1024">1 GB</SelectItem>
                      <SelectItem value="2048">2 GB</SelectItem>
                      <SelectItem value="4096">4 GB</SelectItem>
                      <SelectItem value="8192">8 GB</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>
            </TabsContent>

            <TabsContent value="commands" className="space-y-4 pt-4">
              <div className="space-y-2">
                <Label htmlFor="initCommands">
                  Init Commands (one per line)
                </Label>
                <Textarea
                  id="initCommands"
                  rows={4}
                  value={formData.initCommands}
                  onChange={(e) =>
                    setFormData({ ...formData, initCommands: e.target.value })
                  }
                  placeholder="bun install&#10;bun run build"
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="startCommands">
                  Start Commands (one per line)
                </Label>
                <Textarea
                  id="startCommands"
                  rows={3}
                  value={formData.startCommands}
                  onChange={(e) =>
                    setFormData({ ...formData, startCommands: e.target.value })
                  }
                  placeholder="bun run dev &"
                />
              </div>
            </TabsContent>

            <TabsContent value="secrets" className="space-y-6 pt-4">
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <Label>Environment Variables</Label>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={addEnvSecret}
                  >
                    <Plus className="h-4 w-4 mr-1" />
                    Add Variable
                  </Button>
                </div>

                {envSecrets.length === 0 ? (
                  <p className="text-sm text-muted-foreground">
                    No environment variables configured
                  </p>
                ) : (
                  <div className="space-y-2">
                    {envSecrets.map((secret, index) => (
                      <div key={index} className="flex gap-2">
                        <Input
                          placeholder="KEY"
                          value={secret.key}
                          onChange={(e) =>
                            updateEnvSecret(index, "key", e.target.value)
                          }
                          className="flex-1 min-w-0 font-mono text-sm"
                        />
                        <Input
                          type="password"
                          placeholder="value"
                          value={secret.value}
                          onChange={(e) =>
                            updateEnvSecret(index, "value", e.target.value)
                          }
                          className="flex-1 min-w-0"
                        />
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          className="shrink-0"
                          onClick={() => removeEnvSecret(index)}
                        >
                          <Trash2 className="h-4 w-4 text-destructive" />
                        </Button>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              <div className="border-t pt-4 space-y-3">
                <div className="flex items-center justify-between">
                  <Label>File Secrets</Label>
                  <div className="flex gap-2">
                    <Select onValueChange={(id) => addFileSecret(id)}>
                      <SelectTrigger className="w-[160px]">
                        <SelectValue placeholder="Add preset..." />
                      </SelectTrigger>
                      <SelectContent>
                        {FILE_SECRET_PRESETS.map((preset) => (
                          <SelectItem key={preset.id} value={preset.id}>
                            {preset.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => addFileSecret()}
                    >
                      <Plus className="h-4 w-4 mr-1" />
                      Custom
                    </Button>
                  </div>
                </div>

                {fileSecrets.length === 0 ? (
                  <p className="text-sm text-muted-foreground">
                    No file secrets configured
                  </p>
                ) : (
                  <div className="space-y-4">
                    {fileSecrets.map((secret, index) => {
                      const preset = FILE_SECRET_PRESETS.find(
                        (p) => p.path === secret.path,
                      );
                      return (
                        <div
                          key={index}
                          className="border rounded-lg p-3 space-y-3"
                        >
                          <div className="flex items-center justify-between">
                            <div className="flex gap-2 flex-1">
                              <Input
                                placeholder="Name"
                                value={secret.name}
                                onChange={(e) =>
                                  updateFileSecret(
                                    index,
                                    "name",
                                    e.target.value,
                                  )
                                }
                                className="max-w-[200px]"
                              />
                              <Input
                                placeholder="~/.aws/credentials"
                                value={secret.path}
                                onChange={(e) =>
                                  updateFileSecret(
                                    index,
                                    "path",
                                    e.target.value,
                                  )
                                }
                                className="flex-1 font-mono text-sm"
                              />
                            </div>
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon"
                              onClick={() => removeFileSecret(index)}
                            >
                              <Trash2 className="h-4 w-4 text-destructive" />
                            </Button>
                          </div>
                          <Textarea
                            placeholder={
                              preset?.placeholder || "File content..."
                            }
                            value={secret.content}
                            onChange={(e) =>
                              updateFileSecret(index, "content", e.target.value)
                            }
                            rows={4}
                            className="font-mono text-sm"
                          />
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            </TabsContent>
          </Tabs>

          <DialogFooter className="mt-6">
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={updateMutation.isPending}>
              {updateMutation.isPending ? "Saving..." : "Save"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
