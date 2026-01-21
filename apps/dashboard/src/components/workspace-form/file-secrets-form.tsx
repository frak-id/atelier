import { Plus, Trash2 } from "lucide-react";
import type { FileSecret } from "@/api/client";
import { Button } from "@/components/ui/button";
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

export interface FileSecretInput {
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

export function parseFileSecrets(
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

export function serializeFileSecrets(
  fileSecrets: FileSecretInput[],
): FileSecret[] {
  return fileSecrets
    .filter((s) => s.name.trim() && s.path.trim() && s.content.trim())
    .map((s) => ({
      name: s.name.trim(),
      path: s.path.trim(),
      content: s.content,
      mode: s.mode || "0600",
    }));
}

interface FileSecretsFormProps {
  secrets: FileSecretInput[];
  onChange: (secrets: FileSecretInput[]) => void;
}

export function FileSecretsForm({ secrets, onChange }: FileSecretsFormProps) {
  const addSecret = (presetId?: string) => {
    if (presetId) {
      const preset = FILE_SECRET_PRESETS.find((p) => p.id === presetId);
      if (preset) {
        onChange([
          ...secrets,
          { name: preset.name, path: preset.path, content: "", mode: "0600" },
        ]);
        return;
      }
    }
    onChange([...secrets, { name: "", path: "", content: "", mode: "0600" }]);
  };

  const removeSecret = (index: number) => {
    onChange(secrets.filter((_, i) => i !== index));
  };

  const updateSecret = (
    index: number,
    field: keyof FileSecretInput,
    value: string,
  ) => {
    onChange(
      secrets.map((s, i) => (i === index ? { ...s, [field]: value } : s)),
    );
  };

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <Label>File Secrets</Label>
        <div className="flex gap-2">
          <Select onValueChange={(id) => addSecret(id)}>
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
            onClick={() => addSecret()}
          >
            <Plus className="h-4 w-4 mr-1" />
            Custom
          </Button>
        </div>
      </div>

      {secrets.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No file secrets configured
        </p>
      ) : (
        <div className="space-y-4">
          {secrets.map((secret, index) => {
            const preset = FILE_SECRET_PRESETS.find(
              (p) => p.path === secret.path,
            );
            return (
              <div
                key={`file-${index}`}
                className="border rounded-lg p-3 space-y-3"
              >
                <div className="flex items-center justify-between">
                  <div className="flex gap-2 flex-1">
                    <Input
                      placeholder="Name"
                      value={secret.name}
                      onChange={(e) =>
                        updateSecret(index, "name", e.target.value)
                      }
                      className="max-w-[200px]"
                    />
                    <Input
                      placeholder="~/.aws/credentials"
                      value={secret.path}
                      onChange={(e) =>
                        updateSecret(index, "path", e.target.value)
                      }
                      className="flex-1 font-mono text-sm"
                    />
                  </div>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    onClick={() => removeSecret(index)}
                  >
                    <Trash2 className="h-4 w-4 text-destructive" />
                  </Button>
                </div>
                <Textarea
                  placeholder={preset?.placeholder || "File content..."}
                  value={secret.content}
                  onChange={(e) =>
                    updateSecret(index, "content", e.target.value)
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
  );
}
